/**
 * seed-tracks.ts
 * ---------------------------------------------------------------------------
 * The starter tracks for Girls Set Go. Run with `npm run db:seed`.
 *
 * Safe to run any number of times: a track that already exists (ignoring
 * capital letters) is left alone, so nothing is duplicated.
 *
 * It lives here, NOT in a database migration, on purpose: tracks are DATA.
 * A different organisation using this system would run its own seed and
 * never inherit these tracks.
 */
import { Prisma } from '@prisma/client';

import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { labelKey } from './catalog.util';

export const DEFAULT_TRACKS = [
  { name: 'AI & Robotics', description: 'Artificial intelligence and robotics.' },
  { name: 'UI/UX Design', description: 'User interface and user experience design.' },
] as const;

export async function seedTracks(
  prisma: PrismaService,
  audit: AuditService,
): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];

  for (const track of DEFAULT_TRACKS) {
    try {
      await prisma.$transaction(async (tx) => {
        const row = await tx.track.create({
          data: { name: track.name, nameKey: labelKey(track.name), description: track.description },
          select: { id: true },
        });
        // "Seeded" entries have no actor: the system created them.
        await audit.record({ action: 'track.seeded', entityType: 'track', entityId: row.id, metadata: { name: track.name } }, tx);
      });
      created.push(track.name);
    } catch (error) {
      // Already there (even if two seeds run at once): leave it alone.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        existing.push(track.name);
      } else {
        throw error;
      }
    }
  }

  return { created, existing };
}