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
import { MAX_SUBMISSION_VERSIONS } from './submission.constants';

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

// ------------------------------------------------------------------ may she send (a new version)?

export type SubmissionStatusValue = 'SUBMITTED' | 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';

export const COMPLETE_MESSAGE = 'This assignment was marked complete. Ask your instructor if something needs to change.';
export const versionLimitMessage = (max: number): string =>
  `You have already sent ${max} versions of this assignment. Ask your instructor.`;

export interface SubmitInput {
  phase: SubmissionPhase;
  /** Her submission's status, or null when she has not sent anything yet. */
  status: SubmissionStatusValue | null;
  /** Set while an instructor is asking for changes: the last moment she may resubmit. */
  revisionOpenUntil: Date | null;
  now: Date;
  /** How many versions she has sent so far. */
  versionCount: number;
}

export interface SubmitDecision {
  allowed: boolean;
  /** Why not (shown to her), or null. */
  reason: string | null;
  /** Will the version be labelled Late? (Never when the instructor asked for the changes.) */
  isLate: boolean;
  /** Is this send an answer to "please change this"? */
  asRevision: boolean;
}

/**
 * The ONE rule for sending work, used by the screen ("can I send?") and by the server
 * ("may I accept this?"), so they can never disagree:
 *
 *   - never after the 25-version limit, and never once the assignment was marked complete;
 *   - when an instructor asked for changes, until the date they set - even after the deadline
 *     closed - and it is NOT Late;
 *   - otherwise, until the deadline closes: a student may keep improving her work as new
 *     versions. After the due time (but before the close) the version is labelled Late.
 */
export function submitDecision(input: SubmitInput): SubmitDecision {
  const no = (reason: string): SubmitDecision => ({ allowed: false, reason, isLate: false, asRevision: false });

  if (input.versionCount >= MAX_SUBMISSION_VERSIONS) return no(versionLimitMessage(MAX_SUBMISSION_VERSIONS));
  if (input.status === 'COMPLETED') return no(COMPLETE_MESSAGE);

  const revisionOpen =
    input.status === 'NEEDS_REVISION' && input.revisionOpenUntil !== null && input.now.getTime() <= input.revisionOpenUntil.getTime();
  if (revisionOpen) return { allowed: true, reason: null, isLate: false, asRevision: true };

  if (input.phase === 'CLOSED') return no(CLOSED_MESSAGE);
  return { allowed: true, reason: null, isLate: input.phase === 'LATE', asRevision: false };
}