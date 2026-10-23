/**
 * instructor-cohorts.service.ts
 * ---------------------------------------------------------------------------
 * What an INSTRUCTOR may see: only the cohorts an admin assigned to them.
 *
 * This is the first real use of the ownership rules from Batch 3:
 *   "instructor only sees assigned learning areas".
 * Someone else's cohort looks exactly like a cohort that does not exist
 * (404), so an instructor cannot even discover which cohorts exist.
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/auth.types';
import { PolicyService } from '../auth/policy/policy.service';
import { todayInProgrammeZone } from '../catalog/catalog.util';
import { CohortView, cohortSelect, toCohortView } from '../catalog/cohort.view';
import { buildPage, Paginated, PaginationQueryDto, toSkipTake } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { ListMyCohortsQuery } from './dto/list-my-cohorts.query';

/** The ownership rule's name. Used here and registered in InstructorModule. */
export const COHORT_VIEW_ACTION = 'cohort.view';

@Injectable()
export class InstructorCohortsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
  ) {}

  /** The signed-in instructor's own cohorts. */
  async listMine(user: AuthenticatedUser, query: ListMyCohortsQuery): Promise<Paginated<CohortView>> {
    const today = todayInProgrammeZone();
    // The filter on "instructors: some" IS the ownership rule for lists.
    const where = { status: query.status, instructors: { some: { instructorId: user.id } } };

    const [total, rows] = await Promise.all([
      this.prisma.cohort.count({ where }),
      this.prisma.cohort.findMany({
        where,
        orderBy: [{ startsOn: 'desc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: cohortSelect,
      }),
    ]);

    return buildPage(rows.map((row) => toCohortView(row, today)), total, query);
  }

  /** One cohort - only if it is assigned to this instructor. */
  async getMine(user: AuthenticatedUser, cohortId: string) {
    if (!(await this.policy.can(user, COHORT_VIEW_ACTION, cohortId))) {
      throw new NotFoundException('Cohort not found.'); // same answer as a cohort that does not exist
    }

    const row = await this.prisma.cohort.findUnique({ where: { id: cohortId }, select: cohortSelect });
    if (!row) throw new NotFoundException('Cohort not found.');

    // Co-instructors: names only (no emails or other details).
    const colleagues = await this.prisma.cohortInstructor.findMany({
      where: { cohortId },
      orderBy: [{ assignedAt: 'asc' }, { instructorId: 'asc' }],
      select: { instructor: { select: { id: true, fullName: true } } },
    });

    return {
      cohort: toCohortView(row, todayInProgrammeZone()),
      instructors: colleagues.map((c) => c.instructor),
    };
  }

  /**
   * The students currently enrolled in one of MY cohorts - NAMES ONLY (no
   * emails, phone numbers, dates of birth or guardian details). Someone else's
   * cohort answers "not found", exactly like one that does not exist.
   */
  async listStudents(
    user: AuthenticatedUser,
    cohortId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<{ id: string; fullName: string; enrolledAt: Date }>> {
    if (!(await this.policy.can(user, COHORT_VIEW_ACTION, cohortId))) {
      throw new NotFoundException('Cohort not found.');
    }

    const where = { cohortId, status: 'ACTIVE' as const };
    const [total, rows] = await Promise.all([
      this.prisma.enrollment.count({ where }),
      this.prisma.enrollment.findMany({
        where,
        orderBy: [{ student: { fullName: 'asc' } }, { id: 'asc' }],
        ...toSkipTake(query),
        select: { enrolledAt: true, student: { select: { id: true, fullName: true } } },
      }),
    ]);

    return buildPage(
      rows.map((row) => ({ id: row.student.id, fullName: row.student.fullName, enrolledAt: row.enrolledAt })),
      total,
      query,
    );
  }
}