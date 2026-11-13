/**
 * graded-weeks.ts
 * ---------------------------------------------------------------------------
 * "A week opens when the previous week's lessons are complete AND its assignment has been
 * reviewed." A week counts as GRADED when:
 *   - it has no assignment at all (nothing to wait for), or
 *   - its assignment has been reviewed (in any outcome: reviewed, needs revision, completed).
 * Pure function, so it is easy to test.
 */
import type { Snapshot } from '../course-content/snapshot';

export function gradedWeekIds(snapshot: Snapshot, reviewedAssignmentIds: ReadonlySet<string>): Set<string> {
  return new Set(
    snapshot.weeks
      .filter((week) => !week.assignment || reviewedAssignmentIds.has(week.assignment.id))
      .map((week) => week.id),
  );
}
