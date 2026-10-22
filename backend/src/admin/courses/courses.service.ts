/**
 * courses.service.ts
 * ---------------------------------------------------------------------------
 * The rules for how admins manage courses.
 *
 *  - A course lives inside a track and starts as a DRAFT.
 *  - DRAFT -> PUBLISHED ("publish") and back ("unpublish"). Unpublishing and
 *    archiving are refused while the course still has active cohorts.
 *  - Courses cannot be created in an archived track, and cannot be restored
 *    while their track is archived.
 *  - Nothing is deleted; every change is audited in the same transaction.
 *  - Parent rows are locked while checking children (see row-lock.ts) so two
 *    admins acting at the same instant cannot create an impossible state.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CourseStatus, Prisma, TrackStatus } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { buildPage, Paginated, toSkipTake } from '../../common/pagination/pagination';
import type { DbClient } from '../../common/types/db-client';
import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { cleanLabel, labelKey } from '../../catalog/catalog.util';
import { lockCourse, lockTrack } from '../../catalog/row-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { courseSelect, CourseView, toCourseView } from './course.view';
import type { CreateCourseDto } from './dto/create-course.dto';
import type { ListCoursesQuery } from './dto/list-courses.query';
import type { UpdateCourseDto } from './dto/update-course.dto';

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(admin: AuthenticatedUser, dto: CreateCourseDto, context: RequestContext): Promise<{ course: CourseView }> {
    const title = cleanLabel(dto.title);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await lockTrack(tx, dto.trackId); // take turns with anyone archiving this track
        const track = await tx.track.findUnique({ where: { id: dto.trackId }, select: { status: true } });
        if (!track) throw new NotFoundException('Track not found.');
        if (track.status === TrackStatus.ARCHIVED) {
          throw new ConflictException('Courses cannot be added to an archived track.');
        }

        const created = await tx.course.create({
          data: {
            trackId: dto.trackId,
            title,
            titleKey: labelKey(title),
            description: dto.description?.trim() || null,
            createdById: admin.id,
          },
          select: courseSelect,
        });
        await this.audit.record(
          {
            actorId: admin.id,
            action: 'course.created',
            entityType: 'course',
            entityId: created.id,
            metadata: { title, trackId: dto.trackId },
            ipAddress: context.ipAddress,
          },
          tx,
        );
        return created;
      });
      return { course: toCourseView(row) };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async list(query: ListCoursesQuery): Promise<Paginated<CourseView>> {
    const where: Prisma.CourseWhereInput = {
      ...(query.trackId ? { trackId: query.trackId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.course.count({ where }),
      this.prisma.course.findMany({
        where,
        orderBy: [{ [query.sortBy]: query.sortDir }, { id: 'asc' }],
        ...toSkipTake(query),
        select: courseSelect,
      }),
    ]);

    return buildPage(rows.map(toCourseView), total, query);
  }

  async getOne(id: string): Promise<{ course: CourseView }> {
    const row = await this.prisma.course.findUnique({ where: { id }, select: courseSelect });
    if (!row) throw new NotFoundException('Course not found.');
    return { course: toCourseView(row) };
  }

  async update(
    admin: AuthenticatedUser,
    id: string,
    dto: UpdateCourseDto,
    context: RequestContext,
  ): Promise<{ course: CourseView }> {
    if (dto.title === undefined && dto.description === undefined) {
      throw new BadRequestException('Nothing to update. Provide a title or a description.');
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const current = await tx.course.findUnique({ where: { id }, select: { title: true, description: true } });
        if (!current) throw new NotFoundException('Course not found.');

        const data: Prisma.CourseUpdateInput = {};
        const changed: string[] = [];

        if (dto.title !== undefined && cleanLabel(dto.title) !== current.title) {
          data.title = cleanLabel(dto.title);
          data.titleKey = labelKey(dto.title);
          changed.push('title');
        }
        if (dto.description !== undefined && (dto.description.trim() || null) !== current.description) {
          data.description = dto.description.trim() || null;
          changed.push('description');
        }

        if (changed.length === 0) return tx.course.findUniqueOrThrow({ where: { id }, select: courseSelect });

        const updated = await tx.course.update({ where: { id }, data, select: courseSelect });
        await this.audit.record(
          { actorId: admin.id, action: 'course.updated', entityType: 'course', entityId: id, metadata: { changed }, ipAddress: context.ipAddress },
          tx,
        );
        return updated;
      });
      return { course: toCourseView(row) };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  // ------------------------------------------------- publish / unpublish

  async publish(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ course: CourseView }> {
    return this.changeStatus(admin, id, context, 'course.published', async (tx, current) => {
      if (current.status !== CourseStatus.DRAFT) throw new ConflictException('Only draft courses can be published.');
      return CourseStatus.PUBLISHED;
    });
  }

  async unpublish(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ course: CourseView }> {
    return this.changeStatus(admin, id, context, 'course.unpublished', async (tx, current) => {
      if (current.status !== CourseStatus.PUBLISHED) {
        throw new ConflictException('Only published courses can be unpublished.');
      }
      await this.refuseIfActiveCohorts(tx, id, 'unpublished');
      return CourseStatus.DRAFT;
    });
  }

  // ---------------------------------------------------- archive / restore

  async archive(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ course: CourseView }> {
    return this.changeStatus(admin, id, context, 'course.archived', async (tx, current) => {
      if (current.status === CourseStatus.ARCHIVED) throw new ConflictException('This course is already archived.');
      await this.refuseIfActiveCohorts(tx, id, 'archived');
      return CourseStatus.ARCHIVED;
    });
  }

  /** Restoring brings the course back as a DRAFT (publish it again on purpose). */
  async restore(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ course: CourseView }> {
    const row = await this.prisma.$transaction(async (tx) => {
      // Lock order is always track first, then course.
      const pre = await tx.course.findUnique({ where: { id }, select: { trackId: true } });
      if (!pre) throw new NotFoundException('Course not found.');
      await lockTrack(tx, pre.trackId);
      await lockCourse(tx, id);

      const current = await this.findOrThrow(tx, id);
      if (current.status !== CourseStatus.ARCHIVED) throw new ConflictException('This course is not archived.');

      const track = await tx.track.findUniqueOrThrow({ where: { id: current.trackId }, select: { status: true } });
      if (track.status === TrackStatus.ARCHIVED) {
        throw new ConflictException('The track this course belongs to is archived. Restore the track first.');
      }

      const updated = await tx.course.update({ where: { id }, data: { status: CourseStatus.DRAFT }, select: courseSelect });
      await this.audit.record(
        { actorId: admin.id, action: 'course.restored', entityType: 'course', entityId: id, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });
    return { course: toCourseView(row) };
  }

  // ----------------------------------------------------------------- helpers

  /** Shared shape for status changes: lock, check the rule, update, audit. */
  private async changeStatus(
    admin: AuthenticatedUser,
    id: string,
    context: RequestContext,
    action: string,
    decide: (tx: DbClient, current: { status: CourseStatus; trackId: string }) => Promise<CourseStatus>,
  ): Promise<{ course: CourseView }> {
    const row = await this.prisma.$transaction(async (tx) => {
      await lockCourse(tx, id); // take turns with anyone adding a cohort right now
      const current = await this.findOrThrow(tx, id);
      const newStatus = await decide(tx, current);

      const updated = await tx.course.update({ where: { id }, data: { status: newStatus }, select: courseSelect });
      await this.audit.record(
        { actorId: admin.id, action, entityType: 'course', entityId: id, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });
    return { course: toCourseView(row) };
  }

  private async refuseIfActiveCohorts(tx: DbClient, courseId: string, verb: string): Promise<void> {
    const active = await tx.cohort.count({ where: { courseId, status: { not: 'ARCHIVED' } } });
    if (active > 0) {
      throw new ConflictException(
        `This course still has ${active} active cohort${active === 1 ? '' : 's'}, so it cannot be ${verb}. Archive ${active === 1 ? 'it' : 'them'} first.`,
      );
    }
  }

  private async findOrThrow(db: DbClient, id: string) {
    const row = await db.course.findUnique({ where: { id }, select: { id: true, status: true, trackId: true } });
    if (!row) throw new NotFoundException('Course not found.');
    return row;
  }

  private translateDatabaseError(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException('A course with that title already exists in this track.');
    }
    return error;
  }
}