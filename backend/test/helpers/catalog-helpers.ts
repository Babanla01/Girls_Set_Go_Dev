/**
 * catalog-helpers.ts
 * ---------------------------------------------------------------------------
 * Small helpers for tests that need tracks, courses and cohorts: create them
 * through the REAL admin routes, and work out dates relative to "today" in the
 * programme's timezone.
 */
import {
  formatCalendarDate,
  parseCalendarDate,
  todayInProgrammeZone,
} from '../../src/catalog/catalog.util';
import type { TestAgent } from './test-kit';

/** A calendar date N days from today (negative = in the past), as "YYYY-MM-DD". */
export function dayOffset(days: number): string {
  const date = parseCalendarDate(todayInProgrammeZone());
  date.setUTCDate(date.getUTCDate() + days);
  return formatCalendarDate(date);
}

export async function makeTrack(admin: TestAgent, name = 'AI & Robotics'): Promise<string> {
  const res = await admin.post('/api/v1/admin/tracks').send({ name }).expect(201);
  return res.body.track.id as string;
}

export async function makeCourse(admin: TestAgent, trackId: string, title = 'Intro to AI'): Promise<string> {
  const res = await admin.post('/api/v1/admin/courses').send({ trackId, title }).expect(201);
  return res.body.course.id as string;
}

export async function makeCohort(
  admin: TestAgent,
  courseId: string,
  overrides: Partial<{ name: string; startsOn: string; endsOn: string; capacity: number }> = {},
): Promise<string> {
  const res = await admin
    .post('/api/v1/admin/cohorts')
    .send({ courseId, name: 'Cohort 1', startsOn: dayOffset(7), endsOn: dayOffset(90), ...overrides })
    .expect(201);
  return res.body.cohort.id as string;
}

/** Track + course + cohort in one go. */
export async function makeStack(admin: TestAgent) {
  const trackId = await makeTrack(admin);
  const courseId = await makeCourse(admin, trackId);
  const cohortId = await makeCohort(admin, courseId);
  return { trackId, courseId, cohortId };
}