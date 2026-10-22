/**
 * row-lock.ts
 * ---------------------------------------------------------------------------
 * "Take a lock on this track/course for the rest of the transaction."
 *
 * Why it exists - a real race this prevents:
 *   Admin A archives a track at the exact moment Admin B adds a course to it.
 *   Without locks, A's check ("no active courses?") and B's insert can both
 *   succeed, leaving an ARCHIVED track with a live course inside it.
 *   With the lock, the two transactions take turns, so the second one sees the
 *   first one's result and refuses correctly.
 *
 * Lock ORDER (always parent before child) is track -> course. Keeping one
 * order everywhere means two requests can never wait on each other forever.
 */
import type { DbClient } from '../common/types/db-client';

export async function lockTrack(db: DbClient, trackId: string): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "tracks" WHERE "id" = ${trackId}::uuid FOR UPDATE`;
}

export async function lockCourse(db: DbClient, courseId: string): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "courses" WHERE "id" = ${courseId}::uuid FOR UPDATE`;
}