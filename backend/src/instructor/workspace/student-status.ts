/**
 * student-status.ts
 * ---------------------------------------------------------------------------
 * The status label an instructor sees for a student, as one pure function (no database):
 *
 *   NEEDS_REVIEW     she has work waiting for an instructor
 *   INACTIVE         nothing waiting, and no activity for 21 days or more
 *   NEEDS_ATTENTION  nothing waiting, no activity for 7 days or more - or she was asked for
 *                    changes and her resubmit date is within 2 days (or already past)
 *   ON_TRACK         everything else
 *
 * Checked in that order (so "Inactive" wins over "Needs attention").
 */
import { ATTENTION_AFTER_DAYS, INACTIVE_AFTER_DAYS, REVISION_DEADLINE_WARNING_DAYS } from './workspace.constants';

export const STUDENT_STATUSES = ['NEEDS_REVIEW', 'NEEDS_ATTENTION', 'ON_TRACK', 'INACTIVE'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const STATUS_LABEL: Record<StudentStatus, string> = {
  NEEDS_REVIEW: 'Needs review',
  NEEDS_ATTENTION: 'Needs attention',
  ON_TRACK: 'On track',
  INACTIVE: 'Inactive',
};

/** The order of the students list: the ones who need someone first. */
export const STATUS_PRIORITY: Record<StudentStatus, number> = {
  NEEDS_REVIEW: 0,
  NEEDS_ATTENTION: 1,
  INACTIVE: 2,
  ON_TRACK: 3,
};

export interface StatusInput {
  /** Submissions waiting for review. */
  waitingForReview: number;
  /** The earliest resubmit date among the work sent back for changes (null when none). */
  revisionDeadline: Date | null;
  /** The last sign of life (or the day she joined / the cohort started when there is none yet). */
  lastActivityAt: Date;
  now: Date;
}

const DAY_MS = 86_400_000;

export function studentStatus(input: StatusInput): StudentStatus {
  if (input.waitingForReview > 0) return 'NEEDS_REVIEW';

  const quietDays = (input.now.getTime() - input.lastActivityAt.getTime()) / DAY_MS;
  if (quietDays >= INACTIVE_AFTER_DAYS) return 'INACTIVE';
  if (quietDays >= ATTENTION_AFTER_DAYS) return 'NEEDS_ATTENTION';

  if (input.revisionDeadline && input.revisionDeadline.getTime() - input.now.getTime() <= REVISION_DEADLINE_WARNING_DAYS * DAY_MS) {
    return 'NEEDS_ATTENTION';
  }
  return 'ON_TRACK';
}
