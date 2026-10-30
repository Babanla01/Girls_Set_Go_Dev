/**
 * course-structure.service.ts
 * ---------------------------------------------------------------------------
 * Editing the SHAPE of a course copy: its weeks and the lessons inside them
 * (add, rename, reorder, move, remove).
 *
 * Every change goes through ContentEditor.edit(), so it is permission-checked,
 * takes turns with other edits to the same course copy, refuses closed cohorts
 * and archived courses, and records who edited.
 *
 * Positions are always kept as 1, 2, 3 ... with no gaps. Removing a week or
 * lesson also removes what is inside it, and is written to the audit log (with
 * counts only, never the text).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import type { DbClient } from '../common/types/db-client';
import { ContentEditor } from './content-editor.service';
import { LIMITS } from './course-content.constants';
import { lessonSelect, toLessonView, toWeekView, weekSelect } from './course-content.view';
import type { CreateLessonDto, MoveLessonDto, UpdateLessonDto } from './dto/lesson.dto';
import type { OrderDto } from './dto/order.dto';
import type { CreateWeekDto, UpdateWeekDto } from './dto/week.dto';
import { assertFreshRevision, assertSameSet, insertAt } from './editing-helpers';
import { renumber } from './renumber';

const idsOf = (rows: { id: string }[]): string[] => rows.map((row) => row.id);

@Injectable()
export class CourseStructureService {
  constructor(
    private readonly editor: ContentEditor,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ weeks

  async addWeek(user: AuthenticatedUser, contentId: string, dto: CreateWeekDto) {
    return this.editor.edit(user, contentId, async (tx) => {
      const siblings = await tx.courseWeek.findMany({
        where: { contentId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (siblings.length >= LIMITS.weeks) {
        throw new ConflictException(`A course can have at most ${LIMITS.weeks} weeks.`);
      }

      const created = await tx.courseWeek.create({
        data: { contentId, position: siblings.length + 1, title: dto.title, summary: dto.summary ?? null },
        select: { id: true },
      });
      if (dto.position !== undefined && dto.position <= siblings.length) {
        await renumber(tx, 'course_weeks', insertAt(idsOf(siblings), created.id, dto.position));
      }

      return { week: toWeekView(await tx.courseWeek.findUniqueOrThrow({ where: { id: created.id }, select: weekSelect })) };
    });
  }

  async updateWeek(user: AuthenticatedUser, contentId: string, weekId: string, dto: UpdateWeekDto) {
    if (dto.title === undefined && dto.summary === undefined) throw new BadRequestException('Nothing to update.');

    return this.editor.edit(user, contentId, async (tx) => {
      const week = await this.findWeek(tx, contentId, weekId);
      assertFreshRevision(week.revision, dto.expectedRevision, 'week');

      const data: Prisma.CourseWeekUpdateInput = {};
      if (dto.title !== undefined && dto.title !== week.title) data.title = dto.title;
      if (dto.summary !== undefined && dto.summary !== week.summary) data.summary = dto.summary;
      if (Object.keys(data).length === 0) return { week: toWeekView(week) }; // nothing really changed

      const updated = await tx.courseWeek.update({
        where: { id: weekId },
        data: { ...data, revision: { increment: 1 } },
        select: weekSelect,
      });
      return { week: toWeekView(updated) };
    });
  }

  async removeWeek(user: AuthenticatedUser, contentId: string, weekId: string, context: RequestContext) {
    return this.editor.edit(user, contentId, async (tx) => {
      await this.findWeek(tx, contentId, weekId);

      const lessons = await tx.courseLesson.count({ where: { weekId } });
      const blocks = await tx.lessonBlock.count({ where: { lesson: { weekId } } });

      await tx.courseWeek.delete({ where: { id: weekId } }); // its lessons and blocks go with it

      const remaining = await tx.courseWeek.findMany({
        where: { contentId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      await renumber(tx, 'course_weeks', idsOf(remaining));

      await this.audit.record(
        {
          actorId: user.id,
          action: 'course_content.week_removed',
          entityType: 'course_content',
          entityId: contentId,
          metadata: { weekId, lessons, blocks },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { removed: { lessons, blocks } };
    });
  }

  async reorderWeeks(user: AuthenticatedUser, contentId: string, dto: OrderDto) {
    return this.editor.edit(user, contentId, async (tx) => {
      const current = await tx.courseWeek.findMany({
        where: { contentId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      assertSameSet(idsOf(current), dto.orderedIds);
      await renumber(tx, 'course_weeks', dto.orderedIds);
      return { order: dto.orderedIds };
    });
  }

  // ---------------------------------------------------------------- lessons

  async addLesson(user: AuthenticatedUser, contentId: string, weekId: string, dto: CreateLessonDto) {
    return this.editor.edit(user, contentId, async (tx) => {
      await this.findWeek(tx, contentId, weekId);

      const siblings = await this.lessonIds(tx, weekId);
      if (siblings.length >= LIMITS.lessonsPerWeek) {
        throw new ConflictException(`A week can have at most ${LIMITS.lessonsPerWeek} lessons.`);
      }

      const created = await tx.courseLesson.create({
        data: {
          contentId,
          weekId,
          position: siblings.length + 1,
          title: dto.title,
          summary: dto.summary ?? null,
          estimatedMinutes: dto.estimatedMinutes ?? null,
        },
        select: { id: true },
      });
      if (dto.position !== undefined && dto.position <= siblings.length) {
        await renumber(tx, 'course_lessons', insertAt(siblings, created.id, dto.position));
      }

      return {
        lesson: toLessonView(await tx.courseLesson.findUniqueOrThrow({ where: { id: created.id }, select: lessonSelect })),
      };
    });
  }

  async updateLesson(user: AuthenticatedUser, contentId: string, lessonId: string, dto: UpdateLessonDto) {
    if (dto.title === undefined && dto.summary === undefined && dto.estimatedMinutes === undefined) {
      throw new BadRequestException('Nothing to update.');
    }

    return this.editor.edit(user, contentId, async (tx) => {
      const lesson = await this.findLesson(tx, contentId, lessonId);
      assertFreshRevision(lesson.revision, dto.expectedRevision, 'lesson');

      const data: Prisma.CourseLessonUpdateInput = {};
      if (dto.title !== undefined && dto.title !== lesson.title) data.title = dto.title;
      if (dto.summary !== undefined && dto.summary !== lesson.summary) data.summary = dto.summary;
      if (dto.estimatedMinutes !== undefined && dto.estimatedMinutes !== lesson.estimatedMinutes) {
        data.estimatedMinutes = dto.estimatedMinutes;
      }
      if (Object.keys(data).length === 0) return { lesson: toLessonView(lesson) };

      const updated = await tx.courseLesson.update({
        where: { id: lessonId },
        data: { ...data, revision: { increment: 1 } },
        select: lessonSelect,
      });
      return { lesson: toLessonView(updated) };
    });
  }

  async removeLesson(user: AuthenticatedUser, contentId: string, lessonId: string, context: RequestContext) {
    return this.editor.edit(user, contentId, async (tx) => {
      const lesson = await this.findLesson(tx, contentId, lessonId);
      const blocks = await tx.lessonBlock.count({ where: { lessonId } });

      await tx.courseLesson.delete({ where: { id: lessonId } }); // its blocks go with it
      await renumber(tx, 'course_lessons', await this.lessonIds(tx, lesson.weekId));

      await this.audit.record(
        {
          actorId: user.id,
          action: 'course_content.lesson_removed',
          entityType: 'course_content',
          entityId: contentId,
          metadata: { lessonId, weekId: lesson.weekId, blocks },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { removed: { blocks } };
    });
  }

  async reorderLessons(user: AuthenticatedUser, contentId: string, weekId: string, dto: OrderDto) {
    return this.editor.edit(user, contentId, async (tx) => {
      await this.findWeek(tx, contentId, weekId);
      assertSameSet(await this.lessonIds(tx, weekId), dto.orderedIds);
      await renumber(tx, 'course_lessons', dto.orderedIds);
      return { order: dto.orderedIds };
    });
  }

  /** Moves a lesson (with its blocks) to a place in the same week or in another week of the same course copy. */
  async moveLesson(user: AuthenticatedUser, contentId: string, lessonId: string, dto: MoveLessonDto) {
    return this.editor.edit(user, contentId, async (tx) => {
      const lesson = await this.findLesson(tx, contentId, lessonId);
      await this.findWeek(tx, contentId, dto.weekId);

      if (lesson.weekId === dto.weekId) {
        // Same week: take it out of the list and put it back at the wanted place.
        const others = (await this.lessonIds(tx, dto.weekId)).filter((id) => id !== lessonId);
        await renumber(tx, 'course_lessons', insertAt(others, lessonId, dto.position));
      } else {
        const targetSiblings = await this.lessonIds(tx, dto.weekId);
        if (targetSiblings.length >= LIMITS.lessonsPerWeek) {
          throw new ConflictException(`A week can have at most ${LIMITS.lessonsPerWeek} lessons.`);
        }

        await tx.courseLesson.update({
          where: { id: lessonId },
          data: { weekId: dto.weekId, position: targetSiblings.length + 1 },
        });
        await renumber(tx, 'course_lessons', await this.lessonIds(tx, lesson.weekId)); // close the gap it left
        await renumber(tx, 'course_lessons', insertAt(targetSiblings, lessonId, dto.position));
      }

      return {
        lesson: toLessonView(await tx.courseLesson.findUniqueOrThrow({ where: { id: lessonId }, select: lessonSelect })),
      };
    });
  }

  // ----------------------------------------------------------------- helpers

  private async findWeek(tx: DbClient, contentId: string, weekId: string) {
    const week = await tx.courseWeek.findFirst({ where: { id: weekId, contentId }, select: weekSelect });
    if (!week) throw new NotFoundException('Week not found.');
    return week;
  }

  private async findLesson(tx: DbClient, contentId: string, lessonId: string) {
    const lesson = await tx.courseLesson.findFirst({ where: { id: lessonId, contentId }, select: lessonSelect });
    if (!lesson) throw new NotFoundException('Lesson not found.');
    return lesson;
  }

  private async lessonIds(tx: DbClient, weekId: string): Promise<string[]> {
    const rows = await tx.courseLesson.findMany({
      where: { weekId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return idsOf(rows);
  }
}
