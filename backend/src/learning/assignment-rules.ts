/**
 * assignment-rules.ts
 * ---------------------------------------------------------------------------
 * The deadline rules for assignments, as pure functions (no database).
 *
 *   DUE       3 days after the live class, at 5:00 PM Chicago time
 *   LATE      work is still accepted for 7 more days and is labelled "Late"
 *   CLOSED    after that, nothing can be submitted ("Ask your instructor")
 *
 * "3 days after class" counts CALENDAR days in Chicago, and "5:00 PM" is Chicago wall-clock
 * time, so the deadline stays at 5 PM in winter and in summer. When a week has no live
 * class date yet, there is no deadline and the assignment is simply open.
 */
import { addDaysToLocalDate, localParts, zonedDateTimeToUtc } from '../common/utils/zoned-time';
import { branding } from '../config/branding.config';

export const DUE_DAYS_AFTER_CLASS = 3;
export const DUE_TIME = '17:00';
export const LATE_WINDOW_DAYS = 7;

export type SubmissionPhase = 'NO_DUE_DATE' | 'OPEN' | 'LATE' | 'CLOSED';

export interface Schedule {
  timezone: string;
  classStartsAt: Date | null;
  /** The moment the assignment is due (null when the week has no class date yet). */
  dueAt: Date | null;
  /** The moment late work stops being accepted. */
  closesAt: Date | null;
}

export function scheduleFor(classStartsAt: Date | null, zone: string = branding.timezone): Schedule {
  if (!classStartsAt) return { timezone: zone, classStartsAt: null, dueAt: null, closesAt: null };

  const classDate = localParts(classStartsAt, zone).date;
  const dueDate = addDaysToLocalDate(classDate, DUE_DAYS_AFTER_CLASS);
  const closeDate = addDaysToLocalDate(dueDate, LATE_WINDOW_DAYS);

  return {
    timezone: zone,
    classStartsAt,
    dueAt: zonedDateTimeToUtc(dueDate, DUE_TIME, zone),
    closesAt: zonedDateTimeToUtc(closeDate, DUE_TIME, zone),
  };
}

/** Where the assignment stands at a given moment. */
export function phaseAt(schedule: Schedule, now: Date): SubmissionPhase {
  if (!schedule.dueAt || !schedule.closesAt) return 'NO_DUE_DATE';
  if (now.getTime() <= schedule.dueAt.getTime()) return 'OPEN';
  if (now.getTime() <= schedule.closesAt.getTime()) return 'LATE';
  return 'CLOSED';
}

export const LATE_MESSAGE =
  "This assignment is past its due date. You can still submit - it will be marked 'Late' so your instructor knows.";
export const CLOSED_MESSAGE = 'This assignment is closed. Ask your instructor.';
