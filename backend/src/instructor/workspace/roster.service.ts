/**
 * roster.service.ts
 * ---------------------------------------------------------------------------
 * "Which students may this person see, and how are they doing?" - the ONE place that answers it
 * for the instructor dashboard, the students list and the CSV export.
 *
 *  - SCOPE: an admin sees every current cohort; an instructor only the cohorts assigned to her
 *    (read from the database on every request, so removing an assignment takes effect at once).
 *  - Current cohorts only (planned or active), and only students who are learning now (ACTIVE).
 *  - Numbers come from a handful of batch queries for ALL the students at once - never one
 *    query per student - and are worked out by student-metrics.ts.
 */
import { Injectable } from '@nestjs/common';
import { CohortStatus, EnrollmentStatus, Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { GradingScopeService } from '../../grading/grading-scope.service';
import { PublishedCourseService } from '../../learning/published-course.service';
import { PrismaService } from '../../prisma/prisma.service';
import { computeMetrics, StudentMetrics } from './student-metrics';

/** What is read about a cohort. */
export const cohortSelect = {
  id: true,
  name: true,
  startsOn: true,
  endsOn: true,
  status: true,
  course: { select: { id: true, title: true, track: { select: { name: true } } } },
  courseContent: { select: { id: true, publishedVersion: true } },
} satisfies Prisma.CohortSelect;

export type CohortInfo = Prisma.CohortGetPayload<{ select: typeof cohortSelect }>;

export interface RosterRow {
  enrollmentId: string;
  reference: string;
  enrolledAt: Date;
  student: { id: string; fullName: string };
  cohort: CohortInfo;
  metrics: StudentMetrics;
}

@Injectable()
export class RosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: GradingScopeService,
    private readonly published: PublishedCourseService,
  ) {}

  /** The cohorts she may see (with the optional course / cohort narrowing) and every learning student in them. */
  async load(
    user: AuthenticatedUser,
    filters: { courseId?: string; cohortId?: string } = {},
    now: Date = new Date(),
  ): Promise<{ cohorts: CohortInfo[]; rows: RosterRow[] }> {
    const scopeIds = await this.scope.cohortIds(user);
    if (scopeIds !== null && scopeIds.length === 0) return { cohorts: [], rows: [] };

    const and: Prisma.CohortWhereInput[] = [{ status: { in: [CohortStatus.PLANNED, CohortStatus.ACTIVE] } }];
    if (scopeIds !== null) and.push({ id: { in: scopeIds } });
    if (filters.courseId) and.push({ courseId: filters.courseId });
    if (filters.cohortId) and.push({ id: filters.cohortId });

    const cohorts = await this.prisma.cohort.findMany({
      where: { AND: and },
      orderBy: [{ startsOn: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: cohortSelect,
    });
    if (cohorts.length === 0) return { cohorts, rows: [] };

    const enrollments = await this.prisma.enrollment.findMany({
      where: { status: EnrollmentStatus.ACTIVE, cohortId: { in: cohorts.map((cohort) => cohort.id) } },
      orderBy: [{ enrolledAt: 'asc' }, { id: 'asc' }],
      select: { id: true, reference: true, enrolledAt: true, cohortId: true, student: { select: { id: true, fullName: true } } },
    });

    const cohortById = new Map(cohorts.map((cohort) => [cohort.id, cohort]));
    const metrics = await this.metricsFor(enrollments, cohortById, now);

    const rows = enrollments.flatMap((enrollment) => {
      const cohort = cohortById.get(enrollment.cohortId);
      const numbers = metrics.get(enrollment.id);
      if (!cohort || !numbers) return [];
      return [
        { enrollmentId: enrollment.id, reference: enrollment.reference, enrolledAt: enrollment.enrolledAt, student: enrollment.student, cohort, metrics: numbers },
      ];
    });
    return { cohorts, rows };
  }

  /** Lessons done, submissions and status for each enrollment - from three batch queries. */
  async metricsFor(
    enrollments: readonly { id: string; enrolledAt: Date; cohortId: string }[],
    cohortById: ReadonlyMap<string, CohortInfo>,
    now: Date,
  ): Promise<Map<string, StudentMetrics>> {
    // The lessons of each cohort's LIVE course (none when nothing is published).
    const lessonSets = new Map<string, Set<string> | null>();
    for (const cohort of cohortById.values()) {
      const content = cohort.courseContent;
      if (!content || content.publishedVersion === null) {
        lessonSets.set(cohort.id, null);
        continue;
      }
      const snapshot = await this.published.get(content.id, content.publishedVersion).catch(() => null);
      lessonSets.set(cohort.id, snapshot ? new Set(snapshot.weeks.flatMap((week) => week.lessons.map((lesson) => lesson.id))) : null);
    }

    const ids = enrollments.map((enrollment) => enrollment.id);
    const [progress, submissions] = await Promise.all([
      this.prisma.lessonProgress.findMany({
        where: { enrollmentId: { in: ids }, completedAt: { not: null } },
        select: { enrollmentId: true, lessonId: true, completedAt: true },
      }),
      this.prisma.submission.findMany({
        where: { enrollmentId: { in: ids } },
        select: {
          enrollmentId: true,
          status: true,
          revisionOpenUntil: true,
          versions: { orderBy: { number: 'desc' }, take: 1, select: { createdAt: true } },
        },
      }),
    ]);

    const completedBy = new Map<string, Map<string, Date>>();
    for (const row of progress) {
      if (!row.completedAt) continue;
      const map = completedBy.get(row.enrollmentId) ?? new Map<string, Date>();
      map.set(row.lessonId, row.completedAt);
      completedBy.set(row.enrollmentId, map);
    }
    const submissionsBy = new Map<string, typeof submissions>();
    for (const row of submissions) submissionsBy.set(row.enrollmentId, [...(submissionsBy.get(row.enrollmentId) ?? []), row]);

    const result = new Map<string, StudentMetrics>();
    for (const enrollment of enrollments) {
      const cohort = cohortById.get(enrollment.cohortId);
      if (!cohort) continue;
      result.set(
        enrollment.id,
        computeMetrics({
          enrolledAt: enrollment.enrolledAt,
          cohortStartsOn: cohort.startsOn,
          courseLessonIds: lessonSets.get(cohort.id) ?? null,
          completed: completedBy.get(enrollment.id) ?? new Map(),
          submissions: (submissionsBy.get(enrollment.id) ?? []).map((row) => ({
            status: row.status,
            revisionOpenUntil: row.revisionOpenUntil,
            lastVersionAt: row.versions[0]?.createdAt ?? null,
          })),
          now,
        }),
      );
    }
    return result;
  }
}
