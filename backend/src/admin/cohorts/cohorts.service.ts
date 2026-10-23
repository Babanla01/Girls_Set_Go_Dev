/**
 * cohorts.service.ts
 * ---------------------------------------------------------------------------
 * The rules for how admins manage cohorts and who teaches them.
 *
 *  - A cohort follows ONE course (its track comes from the course).
 *  - It cannot be created inside an archived course, nor restored while its
 *    course is archived. Archived cohorts cannot be edited (restore first).
 *  - A cohort cannot be archived while students are enrolled in it.
 *  - Instructors are assigned to cohorts: not suspended ones, and the
 *    database itself refuses anyone who is not an instructor.
 *  - Removing an assignment takes effect on the instructor's very next
 *    request (access is checked against the database every time).
 *  - Nothing is deleted; every change is audited in the same transaction.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountStatus, CohortStatus, CourseStatus, Prisma, Role } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { buildPage, Paginated, toSkipTake } from '../../common/pagination/pagination';
import type { DbClient } from '../../common/types/db-client';
import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { cleanLabel, labelKey, parseCalendarDate, todayInProgrammeZone, formatCalendarDate } from '../../catalog/catalog.util';
import { CohortView, cohortSelect, toCohortView } from '../../catalog/cohort.view';
import { lockCohort, lockCourse } from '../../catalog/row-lock';
import { PrismaService } from '../../prisma/prisma.service';
import type { AssignInstructorDto } from './dto/assign-instructor.dto';
import type { CreateCohortDto } from './dto/create-cohort.dto';
import type { ListCohortsQuery } from './dto/list-cohorts.query';
import type { UpdateCohortDto } from './dto/update-cohort.dto';

export interface CohortInstructorView {
  id: string;
  fullName: string;
  email: string;
  status: AccountStatus;
  assignedAt: Date;
}

const DATE_ORDER_MESSAGE = 'The end date cannot be before the start date.';

@Injectable()
export class CohortsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ create

  async create(admin: AuthenticatedUser, dto: CreateCohortDto, context: RequestContext): Promise<{ cohort: CohortView }> {
    if (dto.endsOn < dto.startsOn) throw new BadRequestException(DATE_ORDER_MESSAGE); // "YYYY-MM-DD" sorts correctly as text
    const name = cleanLabel(dto.name);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await lockCourse(tx, dto.courseId); // take turns with anyone archiving this course
        const course = await tx.course.findUnique({ where: { id: dto.courseId }, select: { status: true } });
        if (!course) throw new NotFoundException('Course not found.');
        if (course.status === CourseStatus.ARCHIVED) {
          throw new ConflictException('Cohorts cannot be added to an archived course.');
        }

        const created = await tx.cohort.create({
          data: {
            courseId: dto.courseId,
            name,
            nameKey: labelKey(name),
            startsOn: parseCalendarDate(dto.startsOn),
            endsOn: parseCalendarDate(dto.endsOn),
            capacity: dto.capacity ?? null,
            createdById: admin.id,
          },
          select: cohortSelect,
        });
        await this.audit.record(
          {
            actorId: admin.id,
            action: 'cohort.created',
            entityType: 'cohort',
            entityId: created.id,
            metadata: { name, courseId: dto.courseId, startsOn: dto.startsOn, endsOn: dto.endsOn },
            ipAddress: context.ipAddress,
          },
          tx,
        );
        return created;
      });
      return { cohort: toCohortView(row, todayInProgrammeZone()) };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  // -------------------------------------------------------------------- list

  async list(query: ListCohortsQuery): Promise<Paginated<CohortView>> {
    const today = todayInProgrammeZone();
    const todayDate = parseCalendarDate(today);

    const where: Prisma.CohortWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.trackId ? { course: { trackId: query.trackId } } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      ...(query.phase === 'upcoming' ? { startsOn: { gt: todayDate } } : {}),
      ...(query.phase === 'running' ? { startsOn: { lte: todayDate }, endsOn: { gte: todayDate } } : {}),
      ...(query.phase === 'ended' ? { endsOn: { lt: todayDate } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.cohort.count({ where }),
      this.prisma.cohort.findMany({
        where,
        orderBy: [{ [query.sortBy]: query.sortDir }, { id: 'asc' }],
        ...toSkipTake(query),
        select: cohortSelect,
      }),
    ]);

    return buildPage(rows.map((row) => toCohortView(row, today)), total, query);
  }

  // ------------------------------------------------------------------ detail

  async getOne(id: string): Promise<{ cohort: CohortView; instructors: CohortInstructorView[] }> {
    const row = await this.prisma.cohort.findUnique({ where: { id }, select: cohortSelect });
    if (!row) throw new NotFoundException('Cohort not found.');
    return { cohort: toCohortView(row, todayInProgrammeZone()), instructors: await this.instructorsOf(this.prisma, id) };
  }

  // ------------------------------------------------------------------ update

  async update(
    admin: AuthenticatedUser,
    id: string,
    dto: UpdateCohortDto,
    context: RequestContext,
  ): Promise<{ cohort: CohortView }> {
    if (dto.name === undefined && dto.startsOn === undefined && dto.endsOn === undefined && dto.capacity === undefined) {
      throw new BadRequestException('Nothing to update.');
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const current = await tx.cohort.findUnique({
          where: { id },
          select: { name: true, startsOn: true, endsOn: true, capacity: true, status: true },
        });
        if (!current) throw new NotFoundException('Cohort not found.');
        if (current.status === CohortStatus.ARCHIVED) {
          throw new ConflictException('This cohort is archived. Restore it before editing.');
        }

        // Work out the dates as they WOULD be, and check them together.
        const startsOn = dto.startsOn ?? formatCalendarDate(current.startsOn);
        const endsOn = dto.endsOn ?? formatCalendarDate(current.endsOn);
        if (endsOn < startsOn) throw new BadRequestException(DATE_ORDER_MESSAGE);

        const data: Prisma.CohortUpdateInput = {};
        const changed: string[] = [];

        if (dto.name !== undefined && cleanLabel(dto.name) !== current.name) {
          data.name = cleanLabel(dto.name);
          data.nameKey = labelKey(dto.name);
          changed.push('name');
        }
        if (startsOn !== formatCalendarDate(current.startsOn)) {
          data.startsOn = parseCalendarDate(startsOn);
          changed.push('startsOn');
        }
        if (endsOn !== formatCalendarDate(current.endsOn)) {
          data.endsOn = parseCalendarDate(endsOn);
          changed.push('endsOn');
        }
        if (dto.capacity !== undefined && dto.capacity !== current.capacity) {
          data.capacity = dto.capacity; // a number sets it; null removes the limit
          changed.push('capacity');
        }

        if (changed.length === 0) return tx.cohort.findUniqueOrThrow({ where: { id }, select: cohortSelect });

        const updated = await tx.cohort.update({ where: { id }, data, select: cohortSelect });
        await this.audit.record(
          { actorId: admin.id, action: 'cohort.updated', entityType: 'cohort', entityId: id, metadata: { changed }, ipAddress: context.ipAddress },
          tx,
        );
        return updated;
      });
      return { cohort: toCohortView(row, todayInProgrammeZone()) };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  // ---------------------------------------------------------------- archive

  async archive(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ cohort: CohortView }> {
    const row = await this.prisma.$transaction(async (tx) => {
      await lockCohort(tx, id); // take turns with anyone being accepted into it right now
      const current = await tx.cohort.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw new NotFoundException('Cohort not found.');
      if (current.status === CohortStatus.ARCHIVED) throw new ConflictException('This cohort is already archived.');

      const enrolled = await tx.enrollment.count({ where: { cohortId: id, status: 'ACTIVE' } });
      if (enrolled > 0) {
        throw new ConflictException(
          `This cohort still has ${enrolled} enrolled student${enrolled === 1 ? '' : 's'}. Move or withdraw ${enrolled === 1 ? 'her' : 'them'} first.`,
        );
      }

      const updated = await tx.cohort.update({ where: { id }, data: { status: CohortStatus.ARCHIVED }, select: cohortSelect });
      await this.audit.record(
        { actorId: admin.id, action: 'cohort.archived', entityType: 'cohort', entityId: id, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });
    return { cohort: toCohortView(row, todayInProgrammeZone()) };
  }

  async restore(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ cohort: CohortView }> {
    const row = await this.prisma.$transaction(async (tx) => {
      const pre = await tx.cohort.findUnique({ where: { id }, select: { courseId: true } });
      if (!pre) throw new NotFoundException('Cohort not found.');
      await lockCourse(tx, pre.courseId); // take turns with anyone archiving the course

      const current = await tx.cohort.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (current.status !== CohortStatus.ARCHIVED) throw new ConflictException('This cohort is not archived.');

      const course = await tx.course.findUniqueOrThrow({ where: { id: pre.courseId }, select: { status: true } });
      if (course.status === CourseStatus.ARCHIVED) {
        throw new ConflictException('The course this cohort follows is archived. Restore the course first.');
      }

      const updated = await tx.cohort.update({ where: { id }, data: { status: CohortStatus.ACTIVE }, select: cohortSelect });
      await this.audit.record(
        { actorId: admin.id, action: 'cohort.restored', entityType: 'cohort', entityId: id, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });
    return { cohort: toCohortView(row, todayInProgrammeZone()) };
  }

  // ------------------------------------------------- teaching assignments

  async assignInstructor(
    admin: AuthenticatedUser,
    cohortId: string,
    dto: AssignInstructorDto,
    context: RequestContext,
  ): Promise<{ instructors: CohortInstructorView[] }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cohort = await tx.cohort.findUnique({ where: { id: cohortId }, select: { status: true } });
        if (!cohort) throw new NotFoundException('Cohort not found.');
        if (cohort.status === CohortStatus.ARCHIVED) {
          throw new ConflictException('Instructors cannot be assigned to an archived cohort.');
        }

        const instructor = await tx.user.findFirst({
          where: { id: dto.instructorId, role: Role.INSTRUCTOR },
          select: { status: true },
        });
        if (!instructor) throw new NotFoundException('Instructor not found.');
        if (instructor.status === AccountStatus.SUSPENDED) {
          throw new ConflictException('Suspended instructors cannot be assigned.');
        }

        await tx.cohortInstructor.create({
          data: { cohortId, instructorId: dto.instructorId, assignedById: admin.id },
        });
        await this.audit.record(
          {
            actorId: admin.id,
            action: 'cohort.instructor_assigned',
            entityType: 'cohort',
            entityId: cohortId,
            metadata: { instructorId: dto.instructorId },
            ipAddress: context.ipAddress,
          },
          tx,
        );
        return { instructors: await this.instructorsOf(tx, cohortId) };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That instructor is already assigned to this cohort.');
      }
      throw error;
    }
  }

  async removeInstructor(
    admin: AuthenticatedUser,
    cohortId: string,
    instructorId: string,
    context: RequestContext,
  ): Promise<{ instructors: CohortInstructorView[] }> {
    return this.prisma.$transaction(async (tx) => {
      const cohort = await tx.cohort.findUnique({ where: { id: cohortId }, select: { id: true } });
      if (!cohort) throw new NotFoundException('Cohort not found.');

      const removed = await tx.cohortInstructor.deleteMany({ where: { cohortId, instructorId } });
      if (removed.count === 0) throw new NotFoundException('That instructor is not assigned to this cohort.');

      await this.audit.record(
        {
          actorId: admin.id,
          action: 'cohort.instructor_removed',
          entityType: 'cohort',
          entityId: cohortId,
          metadata: { instructorId },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { instructors: await this.instructorsOf(tx, cohortId) };
    });
  }

  // ----------------------------------------------------------------- helpers

  private async instructorsOf(db: DbClient, cohortId: string): Promise<CohortInstructorView[]> {
    const rows = await db.cohortInstructor.findMany({
      where: { cohortId },
      orderBy: [{ assignedAt: 'asc' }, { instructorId: 'asc' }],
      select: { assignedAt: true, instructor: { select: { id: true, fullName: true, email: true, status: true } } },
    });
    return rows.map((row) => ({ ...row.instructor, assignedAt: row.assignedAt }));
  }

  private translateDatabaseError(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException('A cohort with that name already exists for this course.');
    }
    return error;
  }
}