/**
 * catalog.util.ts
 * ---------------------------------------------------------------------------
 * Small shared helpers for tracks, courses and cohorts:
 *   - cleaning names so "  AI   &  Robotics " and "ai & robotics" match
 *   - working with CALENDAR DATES (no time of day), like "2026-11-03"
 *   - deciding whether a cohort is upcoming, running or ended
 *
 * Pure functions, no database: easy to test on their own.
 */
import { branding } from '../config/branding.config';

// ------------------------------------------------------------------- names

/** Trims the ends and squashes repeated spaces: "  AI   &  Robotics " -> "AI & Robotics". */
export function cleanLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * The lowercase copy of a name that the database uses to forbid duplicates
 * that differ only by capital letters. (A database rule guarantees it always
 * matches the real name.)
 */
export function labelKey(value: string): string {
  return cleanLabel(value).toLowerCase();
}

// ------------------------------------------------------------------- dates

/** True for real calendar dates in the form YYYY-MM-DD (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** "2026-11-03" -> a Date at midnight UTC (how the database stores a DATE). */
export function parseCalendarDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** The reverse: a stored DATE back to "2026-11-03". */
export function formatCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Today's calendar date in the programme's timezone, as "YYYY-MM-DD".
 * `now` can be passed in so tests can pretend it is a different day.
 */
export function todayInProgrammeZone(now: Date = new Date(), timeZone: string = branding.timezone): string {
  // The "en-CA" format happens to be year-month-day, which is what we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// ------------------------------------------------------------------- phase

export const COHORT_PHASES = ['upcoming', 'running', 'ended'] as const;
export type CohortPhase = (typeof COHORT_PHASES)[number];

/**
 * Where a cohort is in time, compared with "today":
 *   upcoming = has not started yet
 *   running  = started, not finished (the first and last days count as running)
 *   ended    = the last day has passed
 */
export function cohortPhase(startsOn: Date, endsOn: Date, today: string): CohortPhase {
  if (today < formatCalendarDate(startsOn)) return 'upcoming';
  if (today > formatCalendarDate(endsOn)) return 'ended';
  return 'running';
}