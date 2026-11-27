/**
 * instructor-dashboard.service.ts
 * ---------------------------------------------------------------------------
 * The instructor's home screen, in ONE call:
 *
 *   numbers   courses, active students, needs review, average progress
 *   courses   one card per cohort: course, cohort, "Week 2 of 8", Published or Planned,
 *             "Live now", how many students, average progress, and the start date
 *   queue     the oldest submissions waiting for review (the same list as the grading inbox).
 *             Each says whether saving a review would OPEN that student's next week.
 *
 * An admin sees every current cohort. An instructor with no cohort gets empty numbers and
 * `hasCohorts: false` (the design has no empty state for this yet, so the screen decides).
 */
import { Injectable } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { branding } from '../../config/branding.config';
import { InboxService } from '../../grading/inbox.service';
import type { InboxQuery } from '../../grading/dto/inbox.query';
import { liveClasses } from '../../learning/dashboard-rules';
import { ProgressStateService } from '../../learning/progress-state.service';
import { PublishedCourseService } from '../../learning/published-course.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RosterService } from './roster.service';
import { averagePercent } from './student-metrics';
import { QUEUE_SIZE } from './workspace.constants';
import { cohortWeek, wouldOpenNextWeek } from './workspace-rules';

@Injectable()
export class InstructorDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roster: RosterService,
    private readonly inbox: InboxService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
  ) {}

  async get(user: AuthenticatedUser) {
    const now = new Date();
    const [{ cohorts, rows }, queue] = await Promise.all([
      this.roster.load(user, {}, now),
      this.inbox.list(user, { status: 'WAITING', page: 1, pageSize: QUEUE_SIZE } as InboxQuery),
    ]);

    // One card per cohort.
    const cards = await Promise.all(
      cohorts.map(async (cohort) => {
        const content = cohort.courseContent;
        const snapshot =
          content && content.publishedVersion !== null ? await this.published.get(content.id, content.publishedVersion).catch(() => null) : null;
        const students = rows.filter((row) => row.cohort.id === cohort.id);
        const running = snapshot ? liveClasses(snapshot, now).next : null;

        return {
          cohortId: cohort.id,
          cohortName: cohort.name,
          cohortStatus: cohort.status,
          course: { id: cohort.course.id, title: cohort.course.title },
          track: cohort.course.track.name,
          published: snapshot !== null,
          liveNow: running !== null && running.startsAt.getTime() <= now.getTime() && now.getTime() < running.endsAt.getTime(),
          week: { current: cohortWeek(cohort.startsOn, snapshot ? snapshot.weeks.length : null, now), total: snapshot ? snapshot.weeks.length : null },
          startsOn: cohort.startsOn,
          students: students.length,
          averageProgress: averagePercent(students.map((row) => row.metrics.percent)),
        };
      }),
    );

    return {
      timezone: branding.timezone,
      hasCohorts: cohorts.length > 0,
      numbers: {
        courses: new Set(cohorts.map((cohort) => cohort.course.id)).size,
        cohorts: cohorts.length,
        activeStudents: rows.length,
        needsReview: queue.counts.waiting,
        averageProgress: averagePercent(rows.map((row) => row.metrics.percent)),
      },
      courses: cards,
      queue: {
        total: queue.total,
        allCaughtUp: queue.allCaughtUp,
        items: await this.withOpensNextWeek(queue.items),
      },
    };
  }

  /** Marks each queue item with "saving a review opens this student's next week", using the real unlock rules. */
  private async withOpensNextWeek<T extends { id: string; assignment: { id: string } }>(items: T[]): Promise<(T & { opensNextWeek: boolean })[]> {
    if (items.length === 0) return [];

    const rows = await this.prisma.submission.findMany({
      where: { id: { in: items.map((item) => item.id) } },
      select: {
        id: true,
        enrollmentId: true,
        enrollment: { select: { status: true, cohort: { select: { courseContent: { select: { id: true, publishedVersion: true } } } } } },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return Promise.all(
      items.map(async (item) => {
        const row = byId.get(item.id);
        const content = row?.enrollment.cohort.courseContent;
        // Reviews only open weeks for a student who is learning now, in a published course.
        if (!row || row.enrollment.status !== EnrollmentStatus.ACTIVE || !content || content.publishedVersion === null) {
          return { ...item, opensNextWeek: false };
        }

        const snapshot = await this.published.get(content.id, content.publishedVersion).catch(() => null);
        const week = snapshot?.weeks.find((candidate) => candidate.assignment?.id === item.assignment.id);
        if (!snapshot || !week) return { ...item, opensNextWeek: false };

        const state = await this.progress.load(this.prisma, row.enrollmentId, snapshot);
        return { ...item, opensNextWeek: wouldOpenNextWeek(snapshot, state, week.id) };
      }),
    );
  }
}
