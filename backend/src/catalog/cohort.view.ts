/**
 * cohort.view.ts
 * ---------------------------------------------------------------------------
 * What a cohort looks like in API responses. Shared by the admin routes and
 * the instructor routes, so both always show the same shape.
 *
 * Dates go out as plain "YYYY-MM-DD" text, and "phase" (upcoming / running /
 * ended) is worked out from today's date in the programme's timezone.
 */
import type { CohortStatus, Prisma } from '@prisma/client';

import { CohortPhase, cohortPhase, formatCalendarDate } from './catalog.util';

export const cohortSelect = {
  id: true,
  name: true,
  startsOn: true,
  endsOn: true,
  capacity: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  course: { select: { id: true, title: true, track: { select: { id: true, name: true } } } },
  _count: { select: { instructors: true } },
} satisfies Prisma.CohortSelect;

export type CohortRow = Prisma.CohortGetPayload<{ select: typeof cohortSelect }>;

export interface CohortView {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  capacity: number | null;
  status: CohortStatus;
  phase: CohortPhase;
  course: { id: string; title: string };
  track: { id: string; name: string };
  instructorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** `today` is "YYYY-MM-DD" in the programme's timezone (computed once per request). */
export function toCohortView(row: CohortRow, today: string): CohortView {
  return {
    id: row.id,
    name: row.name,
    startsOn: formatCalendarDate(row.startsOn),
    endsOn: formatCalendarDate(row.endsOn),
    capacity: row.capacity,
    status: row.status,
    phase: cohortPhase(row.startsOn, row.endsOn, today),
    course: { id: row.course.id, title: row.course.title },
    track: { id: row.course.track.id, name: row.course.track.name },
    instructorCount: row._count.instructors,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}