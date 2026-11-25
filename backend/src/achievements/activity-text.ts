/**
 * activity-text.ts
 * ---------------------------------------------------------------------------
 * Turns a logged event into the plain-English line shown in the student's activity feed.
 * Pure function. It only uses the small facts stored with the event - never feedback text or
 * scores - and it copes with missing facts (an old event whose lesson no longer exists, say).
 */
import { OUTCOME_LABEL } from '../learning/feedback-view';
import { badgeInfo } from './badge-catalog';

type Details = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const quoted = (value: string, fallback: string): string => (value ? `\u201c${value}\u201d` : fallback);

export function describeEvent(type: string, details: unknown): string {
  const d: Details = details !== null && typeof details === 'object' && !Array.isArray(details) ? (details as Details) : {};

  switch (type) {
    case 'ENROLLED':
      return text(d.cohortName) ? `You joined ${text(d.cohortName)}.` : 'You joined your cohort.';

    case 'LESSON_COMPLETED': {
      const week = count(d.weekPosition);
      return `You completed ${quoted(text(d.lessonTitle), 'a lesson')}${week > 0 ? ` (Week ${week})` : ''}.`;
    }

    case 'SUBMISSION_SENT': {
      const title = quoted(text(d.assignmentTitle), 'an assignment');
      const version = count(d.version);
      const files = count(d.files);
      const what = version > 1 ? `You sent version ${version} of ${title}` : `You submitted ${title}`;
      return `${what}${files > 0 ? ` with ${files} file${files === 1 ? '' : 's'}` : ''}${d.late === true ? ' (late)' : ''}.`;
    }

    case 'REVIEW_RECEIVED': {
      const title = quoted(text(d.assignmentTitle), 'your assignment');
      const outcome = OUTCOME_LABEL[text(d.outcome) as keyof typeof OUTCOME_LABEL];
      return outcome ? `Your instructor reviewed ${title}: ${outcome}.` : `Your instructor reviewed ${title}.`;
    }

    case 'BADGE_EARNED': {
      const badge = badgeInfo(text(d.badge));
      return badge ? `You earned the \u201c${badge.name}\u201d badge.` : 'You earned a badge.';
    }

    default:
      return 'Something happened in your learning.';
  }
}
