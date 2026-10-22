/**
 * track.view.ts - what a track looks like in API responses.
 * Queries ask the database for only these fields, and the mapper copies them
 * one by one (so nothing is exposed by accident).
 */
import type { Prisma, TrackStatus } from '@prisma/client';

export const trackSelect = {
  id: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  // How many courses are still in use (not archived) - what blocks archiving.
  _count: { select: { courses: { where: { status: { not: 'ARCHIVED' } } } } },
} satisfies Prisma.TrackSelect;

export type TrackRow = Prisma.TrackGetPayload<{ select: typeof trackSelect }>;

export interface TrackView {
  id: string;
  name: string;
  description: string | null;
  status: TrackStatus;
  activeCourseCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toTrackView(row: TrackRow): TrackView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    activeCourseCount: row._count.courses,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}