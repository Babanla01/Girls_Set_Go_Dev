/**
 * snapshot.ts
 * ---------------------------------------------------------------------------
 * A SNAPSHOT is a frozen picture of a whole course copy: every week, every
 * lesson in it and every block in each lesson, in order. A published version IS
 * a snapshot; the draft is turned into one whenever we need to compare it.
 *
 * Positions are implied by the order of the lists, so a snapshot never has gaps
 * or duplicate positions. Every item keeps its permanent id, which is how two
 * snapshots are compared ("this is the same lesson, with a new title").
 */
import { InternalServerErrorException } from '@nestjs/common';
import type { BlockType, Prisma } from '@prisma/client';

import type { DbClient } from '../common/types/db-client';

export interface SnapshotBlock {
  id: string;
  type: BlockType;
  instructorOnly: boolean;
  data: Prisma.JsonObject;
  /** The template item this one was copied from (empty if it was created here). */
  originId: string | null;
}

export interface SnapshotLesson {
  id: string;
  title: string;
  summary: string | null;
  estimatedMinutes: number | null;
  originId: string | null;
  blocks: SnapshotBlock[];
}

export interface SnapshotWeek {
  id: string;
  title: string;
  summary: string | null;
  originId: string | null;
  lessons: SnapshotLesson[];
}

export interface Snapshot {
  /** The layout of this snapshot, so a future change can still read old versions. */
  format: 1;
  weeks: SnapshotWeek[];
}

export const EMPTY_SNAPSHOT: Snapshot = { format: 1, weeks: [] };

/** Who last changed an item and when (from the draft rows). */
export interface ItemMeta {
  editedById: string | null;
  updatedAt: Date;
}

export interface DraftLoad {
  snapshot: Snapshot;
  /** item id -> who / when. */
  meta: Map<string, ItemMeta>;
}

/** Reads the current DRAFT of a course copy and turns it into a snapshot (3 queries). */
export async function loadDraft(db: DbClient, contentId: string): Promise<DraftLoad> {
  const order = [{ position: 'asc' as const }, { id: 'asc' as const }];
  const weeks = await db.courseWeek.findMany({ where: { contentId }, orderBy: order });
  const lessons = await db.courseLesson.findMany({ where: { contentId }, orderBy: order });
  const blocks = await db.lessonBlock.findMany({ where: { contentId }, orderBy: order });

  const meta = new Map<string, ItemMeta>();
  for (const row of [...weeks, ...lessons, ...blocks]) {
    meta.set(row.id, { editedById: row.editedById, updatedAt: row.updatedAt });
  }

  const blocksByLesson = new Map<string, SnapshotBlock[]>();
  for (const block of blocks) {
    const list = blocksByLesson.get(block.lessonId) ?? [];
    list.push({
      id: block.id,
      type: block.type,
      instructorOnly: block.instructorOnly,
      data: block.data as Prisma.JsonObject,
      originId: block.originId,
    });
    blocksByLesson.set(block.lessonId, list);
  }

  const lessonsByWeek = new Map<string, SnapshotLesson[]>();
  for (const lesson of lessons) {
    const list = lessonsByWeek.get(lesson.weekId) ?? [];
    list.push({
      id: lesson.id,
      title: lesson.title,
      summary: lesson.summary,
      estimatedMinutes: lesson.estimatedMinutes,
      originId: lesson.originId,
      blocks: blocksByLesson.get(lesson.id) ?? [],
    });
    lessonsByWeek.set(lesson.weekId, list);
  }

  return {
    snapshot: {
      format: 1,
      weeks: weeks.map((week) => ({
        id: week.id,
        title: week.title,
        summary: week.summary,
        originId: week.originId,
        lessons: lessonsByWeek.get(week.id) ?? [],
      })),
    },
    meta,
  };
}

/** Reads a stored snapshot back, refusing anything that is not in the layout we expect. */
export function parseSnapshot(value: Prisma.JsonValue): Snapshot {
  const candidate = value as { format?: unknown; weeks?: unknown } | null;
  if (!candidate || typeof candidate !== 'object' || candidate.format !== 1 || !Array.isArray(candidate.weeks)) {
    throw new InternalServerErrorException('A stored course version could not be read.');
  }
  return value as unknown as Snapshot;
}

export interface SnapshotCounts {
  weeks: number;
  lessons: number;
  blocks: number;
}

export function countSnapshot(snapshot: Snapshot): SnapshotCounts {
  let lessons = 0;
  let blocks = 0;
  for (const week of snapshot.weeks) {
    lessons += week.lessons.length;
    for (const lesson of week.lessons) blocks += lesson.blocks.length;
  }
  return { weeks: snapshot.weeks.length, lessons, blocks };
}
