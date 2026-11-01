/**
 * published-course.service.ts
 * ---------------------------------------------------------------------------
 * Reads the PUBLISHED (live) version of a course copy.
 *
 * A published version never changes, so once it is read it can be kept in memory
 * for as long as the server runs: every student request after the first one is
 * served without touching the database for the (potentially large) course
 * snapshot. The cache keeps the most recently used versions and forgets the rest.
 * Nothing can go stale: a new publish simply has a new version number.
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import { parseSnapshot, Snapshot } from '../course-content/snapshot';
import { PrismaService } from '../prisma/prisma.service';

/** How many published versions to keep in memory at once. */
const CACHE_SIZE = 32;

@Injectable()
export class PublishedCourseService {
  private readonly cache = new Map<string, Snapshot>();

  constructor(private readonly prisma: PrismaService) {}

  async get(contentId: string, version: number): Promise<Snapshot> {
    const key = `${contentId}:${version}`;

    const cached = this.cache.get(key);
    if (cached) {
      // Mark it as recently used (a Map remembers the order things were put in).
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const row = await this.prisma.courseVersion.findUnique({
      where: { contentId_number: { contentId, number: version } },
      select: { snapshot: true },
    });
    if (!row) throw new NotFoundException('The published course could not be found.');

    const snapshot = parseSnapshot(row.snapshot);
    this.cache.set(key, snapshot);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    return snapshot;
  }
}
