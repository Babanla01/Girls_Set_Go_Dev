/**
 * renumber.ts
 * ---------------------------------------------------------------------------
 * Writes the positions 1, 2, 3 ... for a list of ids in ONE database statement
 * (fast, and nobody ever sees a half-reordered list).
 *
 * The table name comes from a fixed list below, never from user input.
 */
import { Prisma } from '@prisma/client';

import type { DbClient } from '../common/types/db-client';

export type OrderedTable = 'course_weeks' | 'course_lessons' | 'lesson_blocks';

export async function renumber(db: DbClient, table: OrderedTable, orderedIds: readonly string[]): Promise<void> {
  if (orderedIds.length === 0) return;

  const rows = Prisma.join(orderedIds.map((id, index) => Prisma.sql`(${id}::uuid, ${index + 1}::int)`));
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${table}"`)} AS t
       SET "position" = v.pos, "updated_at" = now()
      FROM (VALUES ${rows}) AS v(id, pos)
     WHERE t."id" = v.id
  `;
}
