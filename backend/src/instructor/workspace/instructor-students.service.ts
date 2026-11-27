/**
 * instructor-students.service.ts
 * ---------------------------------------------------------------------------
 * The instructor's STUDENTS: the list, the CSV export, and one student's detail.
 *
 *  LIST    Her cohorts' learning students with search, course / cohort / status filters and paging.
 *          Sorted so the students who need someone come first (needs review, needs attention,
 *          inactive, on track), then by name. The tab counts always cover everything she may see
 *          for the chosen course / cohort - not only the current page, search or status.
 *  EXPORT  The same filtered list as a CSV. Only names and learning numbers: never a phone,
 *          email, school, date of birth or guardian detail. Safe to open in a spreadsheet, capped
 *          at 5,000 rows, and written to the audit log (counts and filters only, never names).
 *  DETAIL  One student: progress, week by week, assignment history, badges, her goal and
 *          interests (read-only), recent activity, and how to reach support. A student outside
 *          the instructor's cohorts gets the same plain 403 as a student that does not exist, so
 *          nobody can find out who exists by guessing - and no student data.
 *
 * Interests and goals are visible to the student, her instructors and admins (PRF-03). Phone,
 * school, date of birth and guardian details are admin-only and are never read here.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';

import { ActivityService } from '../../achievements/activity.service';
import type { ActivityQuery } from '../../achievements/dto/activity.query';
import { BadgesService } from '../../achievements/badges.service';
import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { AuditService } from '../../common/audit/audit.service';
import { buildPage } from '../../common/pagination/pagination';
import { branding } from '../../config/branding.config';
import { GradingScopeService } from '../../grading/grading-scope.service';
import { weeksCompleted } from '../../learning/dashboard-rules';
import { OUTCOME_LABEL } from '../../learning/feedback-view';
import { ProgressStateService } from '../../learning/progress-state.service';
import { PublishedCourseService } from '../../learning/published-course.service';
import { PrismaService } from '../../prisma/prisma.service';
import { initialsOf } from '../../profile/profile-rules';
import { toCsv } from './csv';
import type { StudentsQuery } from './dto/students.query';
import { cohortSelect, RosterRow, RosterService } from './roster.service';
import { STATUS_LABEL, STATUS_PRIORITY } from './student-status';
import {
  EXPORT_MAX_ROWS,
  OUT_OF_SCOPE_MESSAGE,
  RECENT_ACTIVITY,
  SUPPORT_EMAIL,
  SUPPORT_MESSAGE,
} from './workspace.constants';
import { weekState } from './workspace-rules';

@Injectable()
export class InstructorStudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roster: RosterService,
    private readonly scope: GradingScopeService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
    private readonly badges: BadgesService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------- list

  async list(user: AuthenticatedUser, query: StudentsQuery) {
    const { cohorts, rows } = await this.roster.load(user, { courseId: query.courseId, cohortId: query.cohortId });

    const counts = {
      needsReview: rows.filter((row) => row.metrics.status === 'NEEDS_REVIEW').length,
      needsAttention: rows.filter((row) => row.metrics.status === 'NEEDS_ATTENTION').length,
      onTrack: rows.filter((row) => row.metrics.status === 'ON_TRACK').length,
      inactive: rows.filter((row) => row.metrics.status === 'INACTIVE').length,
      total: rows.length,
    };

    const visible = this.filtered(rows, query);
    const start = (query.page - 1) * query.pageSize;
    const items = visible.slice(start, start + query.pageSize).map((row) => this.listItem(row));

    return {
      ...buildPage(items, visible.length, query),
      status: query.status ?? 'ALL',
      counts,
      // For the filter dropdowns: the courses and cohorts she may choose from.
      filters: {
        courses: [...new Map(cohorts.map((cohort) => [cohort.course.id, { id: cohort.course.id, title: cohort.course.title }])).values()],
        cohorts: cohorts.map((cohort) => ({ id: cohort.id, name: cohort.name, courseId: cohort.course.id })),
      },
    };
  }

  // ------------------------------------------------------------------ export

  /** The CSV text, ready to send. */
  async exportCsv(user: AuthenticatedUser, query: StudentsQuery, context: RequestContext): Promise<string> {
    const { rows } = await this.roster.load(user, { courseId: query.courseId, cohortId: query.cohortId });
    const selected = this.filtered(rows, query).slice(0, EXPORT_MAX_ROWS);

    const header = [
      'Student', 'Track', 'Course', 'Cohort', 'Lessons done', 'Lessons total', 'Progress %', 'Status',
      'Submissions sent', 'Waiting for review', 'Needs revision', 'Completed', 'Last activity', 'Joined',
    ];
    const body = selected.map((row) => [
      row.student.fullName,
      row.cohort.course.track.name,
      row.cohort.course.title,
      row.cohort.name,
      row.metrics.lessonsDone,
      row.metrics.lessonsTotal,
      row.metrics.percent,
      STATUS_LABEL[row.metrics.status],
      row.metrics.submissions.total,
      row.metrics.submissions.waiting,
      row.metrics.submissions.needsRevision,
      row.metrics.submissions.completed,
      row.metrics.lastActivityAt ? row.metrics.lastActivityAt.toISOString() : '',
      row.enrolledAt.toISOString(),
    ]);

    // The audit entry holds the numbers and the filters used - never a student's name.
    await this.audit.record({
      actorId: user.id,
      action: 'instructor.students_exported',
      entityType: 'student_list',
      metadata: {
        rows: selected.length,
        truncated: this.filtered(rows, query).length > selected.length,
        courseId: query.courseId ?? null,
        cohortId: query.cohortId ?? null,
        status: query.status ?? 'ALL',
        searched: Boolean(query.search),
      },
      ipAddress: context.ipAddress,
    });

    return toCsv([header, ...body]);
  }

  /** The date in the filename: today in the programme's timezone, like 2026-11-26. */
  fileDate(now: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: branding.timezone }).format(now);
  }

  // ------------------------------------------------------------------ detail

  async detail(user: AuthenticatedUser, enrollmentId: string) {
    const scopeIds = await this.scope.cohortIds(user);

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: {
        id: true,
        reference: true,
        status: true,
        enrolledAt: true,
        cohortId: true,
        student: {
          select: {
            id: true,
            fullName: true,
            // Only the two things instructors may read. Phone, school, date of birth and guardian details stay admin-only.
            studentProfile: { select: { goal: true, interests: true } },
          },
        },
        cohort: { select: { ...cohortSelect, instructors: { select: { instructor: { select: { fullName: true } } } } } },
      },
    });

    // Outside her scope and "does not exist" look exactly the same to an instructor.
    if (!enrollment) {
      if (scopeIds === null) throw new NotFoundException('Student not found.');
      throw new ForbiddenException(OUT_OF_SCOPE_MESSAGE);
    }
    if (scopeIds !== null && !scopeIds.includes(enrollment.cohortId)) throw new ForbiddenException(OUT_OF_SCOPE_MESSAGE);

    const now = new Date();
    const { instructors, ...cohort } = enrollment.cohort;
    const content = cohort.courseContent;
    const snapshot =
      content && content.publishedVersion !== null ? await this.published.get(content.id, content.publishedVersion).catch(() => null) : null;

    const metricsMap = await this.roster.metricsFor([enrollment], new Map([[cohort.id, cohort]]), now);
    const metrics = metricsMap.get(enrollment.id)!;

    // Week by week, with the same unlock rules the student lives by.
    const state = snapshot ? await this.progress.load(this.prisma, enrollment.id, snapshot) : null;
    const weekRows = snapshot && state ? this.progress.evaluate(snapshot, state, enrollment.status === EnrollmentStatus.COMPLETED) : [];

    // Her submissions, newest version first inside each.
    const submissions = await this.prisma.submission.findMany({
      where: { enrollmentId: enrollment.id },
      select: {
        id: true,
        reference: true,
        assignmentId: true,
        status: true,
        versions: {
          orderBy: { number: 'desc' },
          select: { number: true, createdAt: true, isLate: true, review: { select: { outcome: true, createdAt: true } } },
        },
      },
    });
    const submissionByAssignment = new Map(submissions.map((row) => [row.assignmentId, row]));

    const assignments = [
      ...(snapshot?.weeks.flatMap((week, index) => {
        const assignment = week.assignment;
        if (!assignment) return [];
        const submission = submissionByAssignment.get(assignment.id);
        if (!submission && !weekRows[index]?.open) return []; // a locked week has no history yet
        return [this.assignmentEntry(assignment.id, assignment.title, index + 1, week.title, submission)];
      }) ?? []),
      // Work for an assignment that is no longer in the live course stays visible.
      ...submissions
        .filter((row) => !snapshot?.weeks.some((week) => week.assignment?.id === row.assignmentId))
        .map((row) => this.assignmentEntry(row.assignmentId, 'Assignment (no longer in the course)', null, null, row)),
    ];

    const waiting = assignments.filter((entry) => entry.status === 'SUBMITTED').sort((a, b) => +a.lastSubmittedAt! - +b.lastSubmittedAt!);

    // Badges and recent activity (this also does the one-time catch-up of her log, safe to repeat).
    const badgeList = await this.badges.list(enrollment.id);
    const recent = await this.activity.feed(enrollment.id, { page: 1, pageSize: RECENT_ACTIVITY } as ActivityQuery);

    const profile = enrollment.student.studentProfile;
    return {
      id: enrollment.id,
      reference: enrollment.reference,
      enrollmentStatus: enrollment.status,
      joinedAt: enrollment.enrolledAt,
      timezone: branding.timezone,
      student: { id: enrollment.student.id, fullName: enrollment.student.fullName, initials: initialsOf(enrollment.student.fullName) },
      track: cohort.course.track.name,
      course: { id: cohort.course.id, title: cohort.course.title },
      cohort: { id: cohort.id, name: cohort.name, startsOn: cohort.startsOn },
      instructors: instructors.map((row) => row.instructor.fullName),
      status: { value: metrics.status, label: STATUS_LABEL[metrics.status], lastActivityAt: metrics.lastActivityAt },
      progress: {
        lessonsDone: metrics.lessonsDone,
        lessonsTotal: metrics.lessonsTotal,
        percent: metrics.percent,
        weeksCompleted: snapshot && state ? weeksCompleted(snapshot, weekRows, state.graded) : 0,
        weeksTotal: weekRows.length,
      },
      needsReview: {
        count: waiting.length,
        oldest: waiting[0]
          ? {
              submissionId: waiting[0].submissionId,
              reference: waiting[0].reference,
              assignmentTitle: waiting[0].title,
              weekPosition: waiting[0].week?.position ?? null,
              submittedAt: waiting[0].lastSubmittedAt,
            }
          : null,
      },
      weeks: weekRows.map((week) => ({
        id: week.id,
        position: week.position,
        title: week.title,
        lessonsDone: week.lessonsDone,
        lessonsTotal: week.lessonsTotal,
        state: weekState(week, state?.graded.has(week.id) ?? false),
      })),
      assignments,
      badges: { earned: badgeList.earned, count: badgeList.counts.earned, total: badgeList.counts.total },
      goal: profile?.goal ?? null,
      interests: profile?.interests ?? [],
      recentActivity: recent.items,
      support: { message: SUPPORT_MESSAGE, email: SUPPORT_EMAIL },
    };
  }

  // ----------------------------------------------------------------- helpers

  /** Applies the search and the status filter, then orders the students who need someone first. */
  private filtered(rows: readonly RosterRow[], query: StudentsQuery): RosterRow[] {
    const search = query.search?.toLowerCase();
    const status = query.status && query.status !== 'ALL' ? query.status : null;

    return rows
      .filter((row) => (!status || row.metrics.status === status) && (!search || row.student.fullName.toLowerCase().includes(search)))
      .sort(
        (a, b) =>
          STATUS_PRIORITY[a.metrics.status] - STATUS_PRIORITY[b.metrics.status] ||
          a.student.fullName.localeCompare(b.student.fullName) ||
          a.enrollmentId.localeCompare(b.enrollmentId),
      );
  }

  private listItem(row: RosterRow) {
    return {
      enrollmentId: row.enrollmentId,
      reference: row.reference,
      joinedAt: row.enrolledAt,
      student: { id: row.student.id, fullName: row.student.fullName, initials: initialsOf(row.student.fullName) },
      track: row.cohort.course.track.name,
      course: { id: row.cohort.course.id, title: row.cohort.course.title },
      cohort: { id: row.cohort.id, name: row.cohort.name },
      lessons: { done: row.metrics.lessonsDone, total: row.metrics.lessonsTotal },
      progressPercent: row.metrics.percent,
      status: row.metrics.status,
      statusLabel: STATUS_LABEL[row.metrics.status],
      submissions: row.metrics.submissions,
      lastActivityAt: row.metrics.lastActivityAt,
    };
  }

  private assignmentEntry(
    assignmentId: string,
    title: string,
    weekPosition: number | null,
    weekTitle: string | null,
    submission?: {
      id: string;
      reference: string;
      status: string;
      versions: { number: number; createdAt: Date; isLate: boolean; review: { outcome: keyof typeof OUTCOME_LABEL; createdAt: Date } | null }[];
    },
  ) {
    const latest = submission?.versions[0];
    const reviewed = submission?.versions.find((version) => version.review !== null);
    return {
      assignmentId,
      title,
      week: weekPosition !== null ? { position: weekPosition, title: weekTitle } : null,
      status: submission ? submission.status : 'NOT_SUBMITTED',
      submissionId: submission?.id ?? null,
      reference: submission?.reference ?? null,
      versions: submission?.versions.length ?? 0,
      isLate: latest?.isLate ?? false,
      lastSubmittedAt: latest?.createdAt ?? null,
      review: reviewed?.review
        ? { outcome: reviewed.review.outcome, outcomeLabel: OUTCOME_LABEL[reviewed.review.outcome], reviewedAt: reviewed.review.createdAt }
        : null,
    };
  }
}
