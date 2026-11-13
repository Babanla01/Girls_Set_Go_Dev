/**
 * progress-state.service.ts
 * ---------------------------------------------------------------------------
 * Everything the rules need to know about ONE student's progress, read in one place:
 *   completed   the lessons she marked complete
 *   unlocked    the weeks already opened for her (by progress, or early by an instructor)
 *   graded      the weeks whose assignment was reviewed (or that have no assignment)
 * and the two things done with it: working out which weeks are open (learning-rules.ts), and
 * RECORDING a week the moment it opens, so it stays open even if the course changes later.
 *
 * Used by the lesson screens, the assignment screens, "open a week early" and by reviews.
 */
import { Injectable } from '@nestjs/common';
import { WeekUnlockSource } from '@prisma/client';

import type { DbClient } from '../common/types/db-client';
import type { Snapshot } from '../course-content/snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { gradedWeekIds } from './graded-weeks';
import { evaluateWeeks, WeekProgress } from './learning-rules';

export interface ProgressState {
  completed: Set<string>;
  unlocked: Set<string>;
  graded: Set<string>;
}

@Injectable()
export class ProgressStateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Three quick queries, run together. */
  async load(db: DbClient, enrollmentId: string, snapshot: Snapshot): Promise<ProgressState> {
    const [done, opened, reviewed] = await Promise.all([
      db.lessonProgress.findMany({ where: { enrollmentId, completedAt: { not: null } }, select: { lessonId: true } }),
      db.weekUnlock.findMany({ where: { enrollmentId }, select: { weekId: true } }),
      db.submission.findMany({
        where: { enrollmentId, versions: { some: { review: { isNot: null } } } },
        select: { assignmentId: true },
      }),
    ]);

    return {
      completed: new Set(done.map((row) => row.lessonId)),
      unlocked: new Set(opened.map((row) => row.weekId)),
      graded: gradedWeekIds(snapshot, new Set(reviewed.map((row) => row.assignmentId))),
    };
  }

  /** Which weeks are open, and how far she got in each. `allOpen` is for a student who finished the course. */
  evaluate(snapshot: Snapshot, state: ProgressState, allOpen = false): WeekProgress[] {
    return evaluateWeeks(snapshot, {
      completed: state.completed,
      unlocked: state.unlocked,
      gradedWeeks: state.graded,
      allOpen,
    });
  }

  /** Remembers the weeks that just opened (those open `after` but not `before`) and returns them. */
  async recordOpenings(
    db: DbClient,
    enrollmentId: string,
    before: readonly WeekProgress[],
    after: readonly WeekProgress[],
  ): Promise<WeekProgress[]> {
    const justOpened = after.filter((week, index) => week.open && !before[index].open);
    if (justOpened.length > 0) {
      await db.weekUnlock.createMany({
        data: justOpened.map((week) => ({ enrollmentId, weekId: week.id, source: WeekUnlockSource.PROGRESS })),
        skipDuplicates: true,
      });
    }
    return justOpened;
  }
}
