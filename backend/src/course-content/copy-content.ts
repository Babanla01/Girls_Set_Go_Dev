/**
 * copy-content.ts
 * ---------------------------------------------------------------------------
 * Copies all the weeks, lessons and blocks of one course copy into another
 * (used to start a cohort's copy from the course's master template).
 *
 * Every copied item gets a NEW id of its own, and remembers the id of the item
 * it came from (`originId`). That memory is what lets a later batch tell "this
 * is still the template's lesson" when template updates are pulled or pushed.
 */
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { DbClient } from '../common/types/db-client';

export interface CopyCounts {
  weeks: number;
  lessons: number;
  blocks: number;
}

export async function copyContent(db: DbClient, fromContentId: string, toContentId: string): Promise<CopyCounts> {
  const weeks = await db.courseWeek.findMany({
    where: { contentId: fromContentId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  const lessons = await db.courseLesson.findMany({
    where: { contentId: fromContentId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  const blocks = await db.lessonBlock.findMany({
    where: { contentId: fromContentId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });

  // old id -> new id
  const newWeekIds = new Map(weeks.map((week) => [week.id, randomUUID()]));
  const newLessonIds = new Map(lessons.map((lesson) => [lesson.id, randomUUID()]));

  await db.courseWeek.createMany({
    data: weeks.map((week) => ({
      id: newWeekIds.get(week.id),
      contentId: toContentId,
      position: week.position,
      title: week.title,
      summary: week.summary,
      originId: week.id,
    })),
  });

  await db.courseLesson.createMany({
    data: lessons.map((lesson) => ({
      id: newLessonIds.get(lesson.id),
      contentId: toContentId,
      weekId: newWeekIds.get(lesson.weekId) as string,
      position: lesson.position,
      title: lesson.title,
      summary: lesson.summary,
      estimatedMinutes: lesson.estimatedMinutes,
      originId: lesson.id,
    })),
  });

  await db.lessonBlock.createMany({
    data: blocks.map((block) => ({
      contentId: toContentId,
      lessonId: newLessonIds.get(block.lessonId) as string,
      position: block.position,
      type: block.type,
      instructorOnly: block.instructorOnly,
      data: block.data as Prisma.InputJsonValue,
      originId: block.id,
    })),
  });

  return { weeks: weeks.length, lessons: lessons.length, blocks: blocks.length };
}
