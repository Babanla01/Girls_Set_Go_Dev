/**
 * inbox.service.ts
 * ---------------------------------------------------------------------------
 * The grading inbox: the submissions an instructor (or admin) can review.
 *
 *  - Default view: WAITING (sent, not yet reviewed), OLDEST FIRST, so nobody waits longest.
 *    Other views show the most recent activity first.
 *  - Filters: status, cohort, course, a date range (last activity, Chicago time), and a search
 *    by student name or receipt number. Results are paginated.
 *  - The tab counts always cover everything the person may see (not only the current page).
 *  - When nothing is waiting, "allCaughtUp" is true so the screen can say so.
 *  - Titles (assignment, week) come from the published course version the student answered.
 *  - Only the student's NAME is shown - never her contact or personal details.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, SubmissionStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { buildPage, toSkipTake } from '../common/pagination/pagination';
import { addDaysToLocalDate, zonedDateTimeToUtc } from '../common/utils/zoned-time';
import { branding } from '../config/branding.config';
import { PublishedCourseService } from '../learning/published-course.service';
import { PrismaService } from '../prisma/prisma.service';
import type { InboxQuery, InboxStatus } from './dto/inbox.query';
import { GradingScopeService } from './grading-scope.service';

const STATUS_OF: Record<InboxStatus, SubmissionStatus | null> = {
  WAITING: SubmissionStatus.SUBMITTED,
  NEEDS_REVISION: SubmissionStatus.NEEDS_REVISION,
  REVIEWED: SubmissionStatus.REVIEWED,
  COMPLETED: SubmissionStatus.COMPLETED,
  ALL: null,
};

export interface InboxCounts {
  waiting: number;
  needsRevision: number;
  reviewed: number;
  completed: number;
}

const NO_COUNTS: InboxCounts = { waiting: 0, needsRevision: 0, reviewed: 0, completed: 0 };

@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: GradingScopeService,
    private readonly published: PublishedCourseService,
  ) {}

  async list(user: AuthenticatedUser, query: InboxQuery) {
    const status: InboxStatus = query.status ?? 'WAITING';
    const cohortIds = await this.scope.cohortIds(user);

    // An instructor with no cohorts has nothing to review.
    if (cohortIds !== null && cohortIds.length === 0) {
      return { ...buildPage([], 0, query), status, counts: NO_COUNTS, allCaughtUp: true };
    }

    // What the person may see (and the narrowing she chose), without status / search / dates.
    const visible: Prisma.SubmissionWhereInput[] = [];
    if (cohortIds !== null) visible.push({ enrollment: { cohortId: { in: cohortIds } } });
    if (query.cohortId) visible.push({ enrollment: { cohortId: query.cohortId } });
    if (query.courseId) visible.push({ enrollment: { cohort: { courseId: query.courseId } } });

    const narrowing: Prisma.SubmissionWhereInput[] = [];
    const wanted = STATUS_OF[status];
    if (wanted) narrowing.push({ status: wanted });
    if (query.search) {
      narrowing.push({
        OR: [
          { reference: { contains: query.search, mode: 'insensitive' } },
          { enrollment: { student: { fullName: { contains: query.search, mode: 'insensitive' } } } },
        ],
      });
    }
    if (query.from || query.to) {
      narrowing.push({
        updatedAt: {
          ...(query.from ? { gte: zonedDateTimeToUtc(query.from, '00:00', branding.timezone) } : {}),
          // "to" is a whole day, so the range ends at the start of the next one.
          ...(query.to ? { lt: zonedDateTimeToUtc(addDaysToLocalDate(query.to, 1), '00:00', branding.timezone) } : {}),
        },
      });
    }
    const where: Prisma.SubmissionWhereInput = { AND: [...visible, ...narrowing] };

    const [total, rows, grouped] = await Promise.all([
      this.prisma.submission.count({ where }),
      this.prisma.submission.findMany({
        where,
        // Waiting: the longest wait first. Everything else: the latest activity first.
        orderBy: [{ updatedAt: status === 'WAITING' ? 'asc' : 'desc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: {
          id: true,
          reference: true,
          status: true,
          updatedAt: true,
          assignmentId: true,
          weekId: true,
          _count: { select: { versions: true } },
          versions: { orderBy: { number: 'desc' }, take: 1, select: { number: true, isLate: true, courseVersion: true, createdAt: true } },
          enrollment: {
            select: {
              student: { select: { id: true, fullName: true } },
              cohort: { select: { id: true, name: true, course: { select: { id: true, title: true } }, courseContent: { select: { id: true } } } },
            },
          },
        },
      }),
      this.prisma.submission.groupBy({ by: ['status'], where: { AND: visible }, _count: { _all: true } }),
    ]);

    const items = await Promise.all(
      rows.map(async (row) => {
        const latest = row.versions[0];
        const contentId = row.enrollment.cohort.courseContent?.id;

        // Titles from the course version the student answered.
        let assignmentTitle = 'Assignment';
        let week = { id: row.weekId, position: 0, title: '' };
        if (contentId && latest) {
          const snapshot = await this.published.get(contentId, latest.courseVersion);
          const index = snapshot.weeks.findIndex((candidate) => candidate.assignment?.id === row.assignmentId);
          if (index >= 0) {
            assignmentTitle = snapshot.weeks[index].assignment?.title ?? assignmentTitle;
            week = { id: snapshot.weeks[index].id, position: index + 1, title: snapshot.weeks[index].title };
          }
        }

        return {
          id: row.id,
          reference: row.reference,
          status: row.status,
          student: row.enrollment.student,
          cohort: { id: row.enrollment.cohort.id, name: row.enrollment.cohort.name },
          course: row.enrollment.cohort.course,
          assignment: { id: row.assignmentId, title: assignmentTitle },
          week,
          version: latest?.number ?? 1,
          versionCount: row._count.versions,
          isLate: latest?.isLate ?? false,
          submittedAt: latest?.createdAt ?? row.updatedAt,
          lastActivityAt: row.updatedAt,
        };
      }),
    );

    const counts = this.countsOf(grouped);
    return { ...buildPage(items, total, query), status, counts, allCaughtUp: counts.waiting === 0 };
  }

  /** The next submission waiting for review (the longest wait), or null. Used for "next in the queue". */
  async nextWaiting(user: AuthenticatedUser, excludeId?: string): Promise<{ id: string; reference: string } | null> {
    const cohortIds = await this.scope.cohortIds(user);
    if (cohortIds !== null && cohortIds.length === 0) return null;

    return this.prisma.submission.findFirst({
      where: {
        status: SubmissionStatus.SUBMITTED,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        ...(cohortIds !== null ? { enrollment: { cohortId: { in: cohortIds } } } : {}),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, reference: true },
    });
  }

  private countsOf(grouped: { status: SubmissionStatus; _count: { _all: number } }[]): InboxCounts {
    const counts = { ...NO_COUNTS };
    for (const row of grouped) {
      if (row.status === SubmissionStatus.SUBMITTED) counts.waiting = row._count._all;
      else if (row.status === SubmissionStatus.NEEDS_REVISION) counts.needsRevision = row._count._all;
      else if (row.status === SubmissionStatus.REVIEWED) counts.reviewed = row._count._all;
      else if (row.status === SubmissionStatus.COMPLETED) counts.completed = row._count._all;
    }
    return counts;
  }
}
