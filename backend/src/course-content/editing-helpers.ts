/**
 * editing-helpers.ts
 * ---------------------------------------------------------------------------
 * Small pure functions used when reordering and editing course content.
 * No database here, so they are easy to test on their own.
 */
import { ConflictException } from '@nestjs/common';

/**
 * Puts `id` into a list of ids at a 1-based position (clamped to the ends).
 * No position means "at the end". The original list is never changed.
 *   insertAt(['a','b','c'], 'x', 2)  ->  ['a','x','b','c']
 */
export function insertAt(ids: readonly string[], id: string, position?: number): string[] {
  const result = [...ids];
  const index = position === undefined ? result.length : Math.min(Math.max(position, 1), result.length + 1) - 1;
  result.splice(index, 0, id);
  return result;
}

/**
 * A reorder request must list EVERY item exactly once. If it does not match what
 * is stored now, somebody added or removed something since the screen loaded.
 */
export function assertSameSet(current: readonly string[], given: readonly string[]): void {
  const sameSize = current.length === given.length;
  const currentSet = new Set(current);
  if (!sameSize || given.some((id) => !currentSet.has(id))) {
    throw new ConflictException('The list has changed since you opened it. Reload and try again.');
  }
}

/**
 * Two people editing the same thing: the screen sends the revision it was showing.
 * If the stored revision is newer, someone else saved in between - refuse instead
 * of silently overwriting their work.
 */
export function assertFreshRevision(current: number, expected: number | undefined, what: string): void {
  if (expected !== undefined && expected !== current) {
    throw new ConflictException(`This ${what} was changed by someone else. Reload it to see their changes.`);
  }
}
