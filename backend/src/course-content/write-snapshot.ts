/**
 * write-snapshot.ts
 * ---------------------------------------------------------------------------
 * Writes a SNAPSHOT (a frozen picture of a course copy) into the editable draft
 * tables. It is used in two ways:
 *
 *   freshIds: true   COPYING (a new cohort's copy made from the template).
 *                    Every item gets a NEW id of its own and remembers the id it
 *                    came from (`originId`), which is what lets a later batch tell
 *                    "this is still the template's lesson" when updates are merged.
 *
 *   freshIds: false  RESTORING or DISCARDING (putting an earlier picture back).
 *                    Every item keeps its permanent id and its origin, so anything
 *                    that points at a lesson (such as a student's progress) keeps
 *                    pointing at the same lesson.
 *
 * Positions are written as 1, 2, 3 ... from the order of the lists.
 *
 * A week's ASSIGNMENT travels with it in both cases. A week's LIVE CLASS (its date and
 * time) is written only when restoring: a cohort's copy made from a template starts
 * with no class dates, because every cohort has its own schedule.
 */
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { DbClient } from '../common/types/db-client';
import type { Snapshot, SnapshotCounts } from './snapshot';

/** Removes the whole draft of a course copy (its lessons and blocks go with their weeks). */
export async function clearDraft(db: DbClient, contentId: string): Promise<void> {
  await db.courseWeek.deleteMany({ where: { contentId } });
}

export async function writeSnapshot(
  db: DbClient,
  contentId: string,
  snapshot: Snapshot,
  options: { freshIds: boolean },
): Promise<SnapshotCounts> {
  const weekRows: Prisma.CourseWeekCreateManyInput[] = [];
  const lessonRows: Prisma.CourseLessonCreateManyInput[] = [];
  const blockRows: Prisma.LessonBlockCreateManyInput[] = [];
  const assignmentRows: Prisma.CourseAssignmentCreateManyInput[] = [];
  const classRows: Prisma.CourseClassSessionCreateManyInput[] = [];

  // Copying: new id, origin = the id it came from. Restoring: same id, same origin.
  const identify = (id: string, originId: string | null) =>
    options.freshIds ? { id: randomUUID(), originId: id } : { id, originId };

  snapshot.weeks.forEach((week, weekIndex) => {
    const weekIdentity = identify(week.id, week.originId);
    weekRows.push({
      ...weekIdentity,
      contentId,
      position: weekIndex + 1,
      title: week.title,
      summary: week.summary,
    });

    if (week.assignment) {
      assignmentRows.push({
        ...identify(week.assignment.id, week.assignment.originId),
        contentId,
        weekId: weekIdentity.id,
        title: week.assignment.title,
        brief: week.assignment.brief,
        includes: week.assignment.includes,
        successEvidence: week.assignment.successEvidence,
        expectedMinutes: week.assignment.expectedMinutes,
        allowedFileTypes: week.assignment.allowedFileTypes,
        rubric: week.assignment.rubric as Prisma.InputJsonObject,
        rubricVisible: week.assignment.rubricVisible,
      });
    }
    if (week.classSession && !options.freshIds) {
      classRows.push({
        ...identify(week.classSession.id, week.classSession.originId),
        contentId,
        weekId: weekIdentity.id,
        startsAt: new Date(week.classSession.startsAt),
        durationMinutes: week.classSession.durationMinutes,
        joinUrl: week.classSession.joinUrl,
        notes: week.classSession.notes,
      });
    }

    week.lessons.forEach((lesson, lessonIndex) => {
      const lessonIdentity = identify(lesson.id, lesson.originId);
      lessonRows.push({
        ...lessonIdentity,
        contentId,
        weekId: weekIdentity.id,
        position: lessonIndex + 1,
        title: lesson.title,
        summary: lesson.summary,
        estimatedMinutes: lesson.estimatedMinutes,
      });

      lesson.blocks.forEach((block, blockIndex) => {
        blockRows.push({
          ...identify(block.id, block.originId),
          contentId,
          lessonId: lessonIdentity.id,
          position: blockIndex + 1,
          type: block.type,
          instructorOnly: block.instructorOnly,
          data: block.data as Prisma.InputJsonObject,
        });
      });
    });
  });

  // Parents first, so every lesson and block finds its week / lesson.
  if (weekRows.length > 0) await db.courseWeek.createMany({ data: weekRows });
  if (assignmentRows.length > 0) await db.courseAssignment.createMany({ data: assignmentRows });
  if (classRows.length > 0) await db.courseClassSession.createMany({ data: classRows });
  if (lessonRows.length > 0) await db.courseLesson.createMany({ data: lessonRows });
  if (blockRows.length > 0) await db.lessonBlock.createMany({ data: blockRows });

  return { weeks: weekRows.length, lessons: lessonRows.length, blocks: blockRows.length };
}