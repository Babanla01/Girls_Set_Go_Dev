/**
 * workspace-rules.ts
 * ---------------------------------------------------------------------------
 * Small pure rules used by the instructor dashboard and the student detail (no database):
 *   - which week of the course a cohort is "in" today;
 *   - the state of a week for the instructor (Complete / Waiting for review / In progress / Locked);
 *   - whether saving a review would OPEN the student's next week (the dashboard says so).
 */
import type { Snapshot } from '../../course-content/snapshot';
import { evaluateWeeks, WeekProgress } from '../../learning/learning-rules';
import type { ProgressState } from '../../learning/progress-state.service';

const DAY_MS = 86_400_000;

/**
 * "Week 2 of 8": the cohort's week counted from its start date (a new week every 7 days),
 * never below 1 or above the number of weeks. Null before the cohort starts, or when the course
 * has no published weeks yet.
 */
export function cohortWeek(startsOn: Date, totalWeeks: number | null, now: Date): number | null {
  if (!totalWeeks || totalWeeks < 1) return null;
  const days = Math.floor((now.getTime() - startsOn.getTime()) / DAY_MS);
  if (days < 0) return null;
  return Math.min(Math.floor(days / 7) + 1, totalWeeks);
}

export type WeekState = 'LOCKED' | 'IN_PROGRESS' | 'WAITING' | 'COMPLETE';

/**
 * Locked weeks are locked. A week whose lessons are all done is COMPLETE once its assignment
 * has been reviewed, and WAITING (for review) until then. Anything else open is IN_PROGRESS.
 */
export function weekState(week: WeekProgress, graded: boolean): WeekState {
  if (!week.open) return 'LOCKED';
  if (week.status === 'COMPLETE') return graded ? 'COMPLETE' : 'WAITING';
  return 'IN_PROGRESS';
}

/**
 * Would saving a review for this week's assignment open a week that is closed today? It runs the
 * REAL unlock rules twice - as things are, and with this week counted as reviewed - so the
 * answer can never disagree with what saving the review actually does.
 */
export function wouldOpenNextWeek(snapshot: Snapshot, state: ProgressState, weekId: string): boolean {
  const before = evaluateWeeks(snapshot, { completed: state.completed, unlocked: state.unlocked, gradedWeeks: state.graded });
  const after = evaluateWeeks(snapshot, {
    completed: state.completed,
    unlocked: state.unlocked,
    gradedWeeks: new Set([...state.graded, weekId]),
  });
  return after.some((week, index) => week.open && !before[index].open);
}
