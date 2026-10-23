/**
 * students.service.ts  (admin side)
 * ---------------------------------------------------------------------------
 * READ-ONLY views of students for admins: a searchable list and a detail page.
 * Editing, suspending and moving students between cohorts is "student
 * management" and arrives in the next batch.
 *
 * Only accounts with the STUDENT role are ever returned here.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { buildPage, Paginated, toSkipTake } from '../../common/pagination/pagination';
import { todayInProgrammeZone } from '../../catalog/catalog.util';
import { PrismaService } from '../../prisma/prisma.service';
import type { ListStudentsQuery } from './dto/list-students.query';
import { studentDetailSelect, studentListSelect, StudentSummary, toStudentDetail, toStudentSummary } from './student.view';

@Injectable()
export class AdminStudentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListStudentsQuery): Promise<Paginated<StudentSummary>> {
    // trackId / cohortId describe her CURRENT enrollment.
    const currentEnrollment: Prisma.EnrollmentWhereInput = {
      status: 'ACTIVE',
      ...(query.cohortId ? { cohortId: query.cohortId } : {}),
      ...(query.trackId ? { cohort: { course: { trackId: query.trackId } } } : {}),
    };

    const where: Prisma.UserWhereInput = {
      role: Role.STUDENT,
      ...(query.accountStatus ? { status: query.accountStatus } : {}),
      ...(query.applicationStatus ? { studentApplication: { status: query.applicationStatus } } : {}),
      ...(query.cohortId || query.trackId ? { enrollments: { some: currentEnrollment } } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search.toLowerCase() } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      query.sortBy === 'name'
        ? [{ fullName: query.sortDir }, { id: 'asc' }]
        : [{ createdAt: query.sortDir }, { id: 'asc' }];

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, orderBy, ...toSkipTake(query), select: studentListSelect }),
    ]);

    return buildPage(rows.map(toStudentSummary), total, query);
  }

  async getOne(id: string) {
    const row = await this.prisma.user.findFirst({ where: { id, role: Role.STUDENT }, select: studentDetailSelect });
    if (!row) throw new NotFoundException('Student not found.');
    return { student: toStudentDetail(row, todayInProgrammeZone()) };
  }
}