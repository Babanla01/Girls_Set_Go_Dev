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
