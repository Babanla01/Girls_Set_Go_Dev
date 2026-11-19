/**
 * review-email.ts
 * ---------------------------------------------------------------------------
 * The email a student gets when her work has been reviewed. Pure functions (no database).
 *
 *  WHEN IT IS SENT
 *    - when a review is first saved, and
 *    - when an edit CHANGES THE OUTCOME (for example Reviewed -> Needs changes), because she
 *      must know. Other edits send nothing, so she is not emailed for every typo fix.
 *
 *  WHAT IT CONTAINS
 *    The assignment's title, the outcome in plain words, the date she can resubmit until (for
 *    "needs changes"), and a link to the assignment page. It NEVER contains the feedback text
 *    or the scores: those stay inside the portal, which is the right privacy for students who
 *    are minors.
 */
import type { Prisma } from '@prisma/client';

import { branding } from '../config/branding.config';

export type OutcomeValue = 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';

/**
 * Where a student opens an assignment in the portal: <APP_URL>/learn/assignments/<id>.
 * There is no front-end yet, so this is the ONE place to change when its real address is known.
 */
export const ASSIGNMENT_PAGE_PATH = '/learn/assignments';

export function assignmentPageUrl(appUrl: string, assignmentId: string): string {
  return `${appUrl.replace(/\/+$/, '')}${ASSIGNMENT_PAGE_PATH}/${assignmentId}`;
}

export interface SendInput {
  /** Was there already a review of this version before this save? */
  existedBefore: boolean;
  previousOutcome: OutcomeValue | null;
  outcome: OutcomeValue;
}

/** First save: yes. An edit: only when the outcome changed. */
export function shouldEmail(input: SendInput): boolean {
  return !input.existedBefore || input.previousOutcome !== input.outcome;
}

/** "Fri, Nov 20, 5:00 PM CST" - the resubmit deadline in the programme's timezone. */
export function formatResubmitBy(date: Date, zone: string = branding.timezone): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

export interface PayloadInput {
  fullName: string;
  assignmentTitle: string;
  outcome: OutcomeValue;
  /** This is an UPDATE of an earlier review (the outcome changed). */
  updated: boolean;
  /** The last moment she may resubmit (only for NEEDS_REVISION). */
  revisionOpenUntil: Date | null;
  actionUrl: string;
}

/** The values the "submission-reviewed" template needs (see email.templates.ts). */
export function buildReviewEmailPayload(input: PayloadInput): Prisma.InputJsonObject {
  return {
    fullName: input.fullName,
    assignmentTitle: input.assignmentTitle,
    outcome: input.outcome,
    updated: input.updated,
    ...(input.outcome === 'NEEDS_REVISION' && input.revisionOpenUntil ? { resubmitBy: formatResubmitBy(input.revisionOpenUntil) } : {}),
    actionUrl: input.actionUrl,
  };
}
