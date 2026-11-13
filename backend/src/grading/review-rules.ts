/**
 * review-rules.ts
 * ---------------------------------------------------------------------------
 * Two small rules of reviewing, as pure functions (no database):
 *   - how many days a student gets to resubmit (only for "needs revision");
 *   - who may still EDIT a review (its author, for 24 hours).
 */
import { REVISION_WINDOW_DAYS } from '../learning/submission.constants';
import { EDIT_WINDOW_HOURS, MAX_REVISION_DAYS } from './grading.constants';

export type OutcomeValue = 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';

/**
 * The days to resubmit for this outcome. "Needs revision" uses the number given (7 when none was);
 * the other outcomes take no days at all.
 */
export function revisionDaysFor(outcome: OutcomeValue, requested: number | undefined): { days: number | null; problem: string | null } {
  if (outcome === 'NEEDS_REVISION') {
    const days = requested ?? REVISION_WINDOW_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_REVISION_DAYS) {
      return { days: null, problem: `revisionDays must be a whole number from 1 to ${MAX_REVISION_DAYS}.` };
    }
    return { days, problem: null };
  }
  if (requested !== undefined) return { days: null, problem: 'revisionDays only applies when the outcome is NEEDS_REVISION.' };
  return { days: null, problem: null };
}

export const EDIT_NOT_AUTHOR_MESSAGE = 'Only the instructor who wrote this feedback can change it.';
export const EDIT_EXPIRED_MESSAGE = `Feedback can only be edited for ${EDIT_WINDOW_HOURS} hours after it was first saved.`;

export interface EditInput {
  reviewerId: string;
  userId: string;
  /** When the review was first saved. */
  createdAt: Date;
  now: Date;
}

export interface EditDecision {
  allowed: boolean;
  /** 'AUTHOR' = not hers to edit, 'EXPIRED' = the 24 hours are over. */
  blockedBy: 'AUTHOR' | 'EXPIRED' | null;
  reason: string | null;
}

export function editDecision(input: EditInput): EditDecision {
  if (input.reviewerId !== input.userId) return { allowed: false, blockedBy: 'AUTHOR', reason: EDIT_NOT_AUTHOR_MESSAGE };
  const deadline = input.createdAt.getTime() + EDIT_WINDOW_HOURS * 3_600_000;
  if (input.now.getTime() > deadline) return { allowed: false, blockedBy: 'EXPIRED', reason: EDIT_EXPIRED_MESSAGE };
  return { allowed: true, blockedBy: null, reason: null };
}
