/**
 * lesson-blocks.service.ts
 * ---------------------------------------------------------------------------
 * Editing the blocks inside a lesson: add, edit, hide from students, reorder,
 * remove.
 *
 *  - The contents of every block are checked and cleaned by block-data.ts, so
 *    only valid blocks ever reach the database.
 *  - Editing a block requires the revision the screen was showing. If someone
 *    else saved it in between, the edit is refused with a clear message
 *    instead of silently overwriting their work.
 *  - A block marked "instructor only" is hidden from students.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import type { DbClient } from '../common/types/db-client';
import { normalizeBlockData } from './block-data';
import { ContentEditor } from './content-editor.service';
import { LIMITS } from './course-content.constants';
import { blockSelect, toBlockView } from './course-content.view';
import type { CreateBlockDto, UpdateBlockDto } from './dto/block.dto';
import type { OrderDto } from './dto/order.dto';
import { assertFreshRevision, assertSameSet, insertAt } from './editing-helpers';
import { renumber } from './renumber';

@Injectable()
export class LessonBlocksService {
  constructor(private readonly editor: ContentEditor) {}

  async addBlock(user: AuthenticatedUser, contentId: string, lessonId: string, dto: CreateBlockDto) {
    // Check the contents first: a bad block never even takes the editing lock.
    const data = normalizeBlockData(dto.type, dto.data);

    return this.editor.edit(user, contentId, async (tx) => {
      const lesson = await tx.courseLesson.findFirst({ where: { id: lessonId, contentId }, select: { id: true } });
      if (!lesson) throw new NotFoundException('Lesson not found.');

      const siblings = await this.blockIds(tx, lessonId);
      if (siblings.length >= LIMITS.blocksPerLesson) {
        throw new ConflictException(`A lesson can have at most ${LIMITS.blocksPerLesson} blocks.`);
      }

      const created = await tx.lessonBlock.create({
        data: {
          contentId,
          lessonId,
          position: siblings.length + 1,
          type: dto.type,
          instructorOnly: dto.instructorOnly ?? false,
          data,
        },
        select: { id: true },
      });
      if (dto.position !== undefined && dto.position <= siblings.length) {
        await renumber(tx, 'lesson_blocks', insertAt(siblings, created.id, dto.position));
      }

      return { block: toBlockView(await tx.lessonBlock.findUniqueOrThrow({ where: { id: created.id }, select: blockSelect })) };
    });
  }

  async updateBlock(user: AuthenticatedUser, contentId: string, blockId: string, dto: UpdateBlockDto) {
    if (dto.data === undefined && dto.instructorOnly === undefined) throw new BadRequestException('Nothing to update.');

    return this.editor.edit(user, contentId, async (tx) => {
      const block = await tx.lessonBlock.findFirst({ where: { id: blockId, contentId }, select: blockSelect });
      if (!block) throw new NotFoundException('Block not found.');
      assertFreshRevision(block.revision, dto.expectedRevision, 'block');

      const data: Prisma.LessonBlockUpdateInput = {};
      if (dto.data !== undefined) data.data = normalizeBlockData(block.type, dto.data); // the kind of block never changes
      if (dto.instructorOnly !== undefined && dto.instructorOnly !== block.instructorOnly) {
        data.instructorOnly = dto.instructorOnly;
      }

      const updated = await tx.lessonBlock.update({
        where: { id: blockId },
        data: { ...data, revision: { increment: 1 } },
        select: blockSelect,
      });
      return { block: toBlockView(updated) };
    });
  }

  async removeBlock(user: AuthenticatedUser, contentId: string, blockId: string) {
    return this.editor.edit(user, contentId, async (tx) => {
      const block = await tx.lessonBlock.findFirst({ where: { id: blockId, contentId }, select: { lessonId: true } });
      if (!block) throw new NotFoundException('Block not found.');

      await tx.lessonBlock.delete({ where: { id: blockId } });
      await renumber(tx, 'lesson_blocks', await this.blockIds(tx, block.lessonId));
      return { removed: true };
    });
  }

  async reorderBlocks(user: AuthenticatedUser, contentId: string, lessonId: string, dto: OrderDto) {
    return this.editor.edit(user, contentId, async (tx) => {
      const lesson = await tx.courseLesson.findFirst({ where: { id: lessonId, contentId }, select: { id: true } });
      if (!lesson) throw new NotFoundException('Lesson not found.');

      assertSameSet(await this.blockIds(tx, lessonId), dto.orderedIds);
      await renumber(tx, 'lesson_blocks', dto.orderedIds);
      return { order: dto.orderedIds };
    });
  }

  private async blockIds(tx: DbClient, lessonId: string): Promise<string[]> {
    const rows = await tx.lessonBlock.findMany({
      where: { lessonId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}
