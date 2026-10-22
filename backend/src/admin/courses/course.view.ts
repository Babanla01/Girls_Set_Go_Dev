/**
 * course.view.ts - what a course looks like in API responses (and only that).
 */
import type { CourseStatus, Prisma } from '@prisma/client';

export const courseSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  track: { select: { id: true, name: true } },
  // Cohorts still in use (not archived) - what blocks unpublishing and archiving.
  _count: { select: { cohorts: { where: { status: { not: 'ARCHIVED' } } } } },
} satisfies Prisma.CourseSelect;

export type CourseRow = Prisma.CourseGetPayload<{ select: typeof courseSelect }>;

export interface CourseView {
  id: string;
  title: string;
  description: string | null;
  status: CourseStatus;
  track: { id: string; name: string };
  activeCohortCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toCourseView(row: CourseRow): CourseView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    track: { id: row.track.id, name: row.track.name },
    activeCohortCount: row._count.cohorts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}