/**
 * dashboard.service.ts  (the student's side)
 * ---------------------------------------------------------------------------
 * The learning dashboard: everything a student who is learning (or who has finished) needs on
 * her home screen, in ONE call.
 *
 *   - her track, cohort and instructor(s);
 *   - course progress: lessons done, the percentage, and weeks completed (a week counts only
 *     when its lessons are done AND its assignment was reviewed);
 *   - "Continue learning" (the next lesson) and "this week";
 *   - the feedback-ready card: her latest review (assignment, instructor, date, outcome);
 *   - "your next assignment": title, week, due time (exact instant + timezone) and status;
 *   - live classes: the next one and the last one held. The JOIN LINK is sent only from 10
 *     minutes before the class until it ends - the server enforces it, so it cannot be
 *     read early by looking at the response;
 *   - her goal, her latest badge and badge count, and her 5 latest activity lines;
 *   - for a student who finished the course: her "journey" summary.
 *
 * The pending, declined and accepted states are served by GET /students/me/dashboard (the
 * admissions dashboard); this one is for students whose course is open.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';

import { ActivityService } from '../achievements/activity.service';
import type { ActivityQuery } from '../achievements/dto/activity.query';
import { BadgesService } from '../achievements/badges.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { formatCalendarDate } from '../catalog/catalog.util';
import { branding } from '../config/branding.config';
import { PrismaService } from '../prisma/prisma.service';
import { phaseAt, scheduleFor } from './assignment-rules';
import { journey, liveClasses, nextAssignment, thisWeek, weeksCompleted } from './dashboard-rules';
import { OUTCOME_LABEL } from './feedback-view';
import { LearningAccessService } from './learning-access.service';
import { cohortNotStartedMessage, NOT_OPEN_MESSAGE, NOT_READY_MESSAGE } from './learning.constants';
import { findNextLesson, summarizeProgress } from './learning-rules';
import { ProgressStateService } from './progress-state.service';
import { PublishedCourseService } from './published-course.service';
import { SubmissionsService } from './submissions.service';

/** How many activity lines the dashboard shows (the full list is GET /learn/activity). */
const RECENT_ACTIVITY = 5;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
    private readonly submissions: SubmissionsService,
    private readonly badges: BadgesService,
    private readonly activity: ActivityService,
  ) {}

  async get(user: AuthenticatedUser) {
    const access = await this.access.resolve(user);

    if (access.kind === 'NO_ENROLLMENT') throw new ForbiddenException(NOT_OPEN_MESSAGE);
    if (access.kind === 'NOT_STARTED') {
      return {
        state: 'COHORT_NOT_STARTED' as const,
        message: cohortNotStartedMessage(formatCalendarDate(access.cohort.startsOn)),
        cohort: { id: access.cohort.id, name: access.cohort.name, startsOn: formatCalendarDate(access.cohort.startsOn) },
      };
    }
    if (access.kind === 'NOT_READY') {
      return { state: 'CONTENT_NOT_READY' as const, message: NOT_READY_MESSAGE, cohort: { id: access.cohort.id, name: access.cohort.name } };
    }

    const { context } = access;
    const now = new Date();
    const snapshot = await this.published.get(context.contentId, context.version);

    const [state, summaries, who, latestReview, profile, badgeList] = await Promise.all([
      this.progress.load(this.prisma, context.enrollmentId, snapshot),
      this.submissions.summaries(context.enrollmentId),
      this.prisma.enrollment.findUniqueOrThrow({
        where: { id: context.enrollmentId },
        select: {
          student: { select: { fullName: true } },
          cohort: {
            select: {
              name: true,
              course: { select: { title: true, track: { select: { name: true } } } },
              instructors: { select: { instructor: { select: { fullName: true } } } },
            },
          },
        },
      }),
      this.prisma.submissionReview.findFirst({
        where: { version: { submission: { enrollmentId: context.enrollmentId } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          outcome: true,
          createdAt: true,
          reviewerId: true,
          version: { select: { submission: { select: { assignmentId: true } } } },
        },
      }),
      this.prisma.studentProfile.findUnique({ where: { userId: user.id }, select: { goal: true } }),
      // Also does the one-time catch-up of her activity log and badges.
      this.badges.list(context.enrollmentId),
    ]);

    const weeks = this.progress.evaluate(snapshot, state, context.readOnly);
    const summary = summarizeProgress(weeks);

    // The next assignment, with its due time worked out from the week's live class.
    const next = nextAssignment(snapshot, weeks, summaries);
    let nextAssignmentView = null;
    if (next) {
      const week = snapshot.weeks[next.weekIndex];
      const assignment = week.assignment!;
      const schedule = scheduleFor(week.classSession ? new Date(week.classSession.startsAt) : null);
      nextAssignmentView = {
        id: assignment.id,
        title: assignment.title,
        expectedMinutes: assignment.expectedMinutes,
        week: { id: week.id, position: next.weekIndex + 1, title: week.title },
        status: next.status,
        dueAt: schedule.dueAt,
        closesAt: schedule.closesAt,
        phase: phaseAt(schedule, now),
      };
    }

    // The feedback-ready card: her latest review.
    let latestFeedback = null;
    if (latestReview) {
      const assignmentId = latestReview.version.submission.assignmentId;
      const week = snapshot.weeks.find((candidate) => candidate.assignment?.id === assignmentId);
      const reviewer = await this.prisma.user.findUnique({ where: { id: latestReview.reviewerId }, select: { fullName: true } });
      latestFeedback = {
        assignmentId,
        assignmentTitle: week?.assignment?.title ?? 'Assignment',
        outcome: latestReview.outcome,
        outcomeLabel: OUTCOME_LABEL[latestReview.outcome],
        reviewedAt: latestReview.createdAt,
        reviewer: { fullName: reviewer?.fullName ?? 'Your instructor' },
      };
    }

    const activityPage = await this.activity.feed(context.enrollmentId, { page: 1, pageSize: RECENT_ACTIVITY } as ActivityQuery);

    return {
      state: context.readOnly ? ('COMPLETED' as const) : ('LEARNING' as const),
      timezone: branding.timezone,
      student: { fullName: who.student.fullName },
      track: who.cohort.course.track.name,
      course: who.cohort.course.title,
      cohort: who.cohort.name,
      instructors: who.cohort.instructors.map((row) => row.instructor.fullName),
      progress: {
        lessonsDone: summary.lessonsDone,
        lessonsTotal: summary.lessonsTotal,
        percent: summary.percent,
        weeksCompleted: weeksCompleted(snapshot, weeks, state.graded),
        weeksTotal: summary.weeksTotal,
      },
      continueLearning: findNextLesson(weeks),
      thisWeek: thisWeek(weeks),
      nextAssignment: nextAssignmentView,
      latestFeedback,
      liveClass: liveClasses(snapshot, now),
      goal: profile?.goal ?? null,
      badges: {
        latest: badgeList.earned.length > 0 ? badgeList.earned[badgeList.earned.length - 1] : null,
        count: badgeList.counts.earned,
        total: badgeList.counts.total,
      },
      recentActivity: activityPage.items,
      journey: context.readOnly ? journey(snapshot, summary.lessonsDone, summary.lessonsTotal, summaries) : null,
    };
  }
}
