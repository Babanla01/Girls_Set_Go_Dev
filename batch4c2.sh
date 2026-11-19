#!/usr/bin/env bash
# Batch 4C-2 - the student's side of reviews: feedback on her assignment, and the review email.
# Run from the repo root. (No database change in this batch.)
set -euo pipefail
cd backend

# ============================================================================
cat > src/learning/feedback-view.ts <<'EOF'
/**
 * feedback-view.ts
 * ---------------------------------------------------------------------------
 * What a STUDENT sees of an instructor's review. Pure functions (no database).
 *
 *  - The four scores (1 to 4) with the criterion names, and their total out of 16, are
 *    always shown: they are her own feedback.
 *  - The rubric's level DESCRIPTIONS ("3 = Meets the goal") are shown only when the
 *    instructor made the rubric visible to students.
 *  - The strength and the next step are shown as the instructor last saved them, together with
 *    the time they were reviewed and (when edited within the 24 hours) the time of the edit.
 *  - Only the instructor's NAME is shown - nothing else about her.
 *  - The rubric used is the one from the course version the student answered, so a rubric
 *    edited later never changes how earlier work is described.
 */
import { RUBRIC_CRITERIA } from '../course-content/assignment-data';

export type OutcomeValue = 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';

/** The words a student reads for each outcome. */
export const OUTCOME_LABEL: Record<OutcomeValue, string> = {
  REVIEWED: 'Reviewed',
  NEEDS_REVISION: 'Needs changes',
  COMPLETED: 'Completed',
};

export const MAX_TOTAL_SCORE = RUBRIC_CRITERIA.length * 4;

/** The parts of a stored review this view needs. */
export interface FeedbackRow {
  versionNumber: number;
  scoreUnderstanding: number;
  scoreExecution: number;
  scoreTesting: number;
  scoreCommunication: number;
  strength: string;
  nextStep: string;
  outcome: OutcomeValue;
  revisionDays: number | null;
  createdAt: Date;
  editedAt: Date | null;
}

/** The description of one level of one criterion, or null when the rubric does not have it. */
function descriptionFor(rubric: unknown, key: string, score: number): string | null {
  const criteria = (rubric as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(criteria)) return null;

  const criterion = criteria.find((item) => item && typeof item === 'object' && (item as { key?: unknown }).key === key) as
    | { levels?: unknown }
    | undefined;
  if (!criterion || !Array.isArray(criterion.levels)) return null;

  const level = criterion.levels.find((item) => item && typeof item === 'object' && (item as { score?: unknown }).score === score) as
    | { description?: unknown }
    | undefined;
  return typeof level?.description === 'string' ? level.description : null;
}

export function toStudentFeedback(row: FeedbackRow, reviewerName: string, rubric: unknown, rubricVisible: boolean) {
  const given: Record<string, number> = {
    understanding: row.scoreUnderstanding,
    execution: row.scoreExecution,
    testing: row.scoreTesting,
    communication: row.scoreCommunication,
  };

  const scores = RUBRIC_CRITERIA.map((criterion) => ({
    key: criterion.key,
    name: criterion.name,
    score: given[criterion.key],
    // Only when the instructor chose to show the rubric to students.
    description: rubricVisible ? descriptionFor(rubric, criterion.key, given[criterion.key]) : null,
  }));

  return {
    versionNumber: row.versionNumber,
    outcome: row.outcome,
    outcomeLabel: OUTCOME_LABEL[row.outcome],
    scores,
    total: scores.reduce((sum, item) => sum + item.score, 0),
    maxTotal: MAX_TOTAL_SCORE,
    strength: row.strength,
    nextStep: row.nextStep,
    revisionDays: row.revisionDays,
    reviewedAt: row.createdAt,
    editedAt: row.editedAt,
    reviewer: { fullName: reviewerName },
  };
}
EOF

# ============================================================================
cat > src/grading/review-email.ts <<'EOF'
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
EOF

echo "New 4C-2 files created. Now replace the four files shown below the script."