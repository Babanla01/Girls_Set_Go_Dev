/**
 * student-metrics.ts
 * ---------------------------------------------------------------------------
 * The numbers shown for ONE student in the instructor's lists, worked out from facts that were
 * already read from the database. Pure (no database), so it is easy to test.
 *
 *  - lessons done / total / percent: only lessons that are STILL in the live course count, so a
 *    lesson removed from the course later can never push a student past 100%;
 *  - submission counts: sent, waiting for review, sent back for changes, completed;
 *  - last activity: the most recent lesson she completed or version she sent;
 *  - status: see student-status.ts.
 */
import { studentStatus, StudentStatus } from './student-status';

export interface SubmissionFact {
  status: 'SUBMITTED' | 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';
  revisionOpenUntil: Date | null;
  /** When her latest version was sent. */
  lastVersionAt: Date | null;
}

export interface MetricsInput {
  enrolledAt: Date;
  cohortStartsOn: Date;
  /** The ids of every lesson in the live course (null when nothing is published yet). */
  courseLessonIds: ReadonlySet<string> | null;
  /** lesson id -> when she completed it. */
  completed: ReadonlyMap<string, Date>;
  submissions: readonly SubmissionFact[];
  now: Date;
}

export interface StudentMetrics {
  lessonsDone: number;
  lessonsTotal: number;
  percent: number;
  submissions: { total: number; waiting: number; needsRevision: number; completed: number };
  /** The last thing she actually did (null when she has done nothing yet). */
  lastActivityAt: Date | null;
  status: StudentStatus;
}

const latestOf = (dates: readonly Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.max(...dates.map((date) => date.getTime())));

export function computeMetrics(input: MetricsInput): StudentMetrics {
  const lessonsTotal = input.courseLessonIds ? input.courseLessonIds.size : 0;
  const lessonsDone = input.courseLessonIds ? [...input.completed.keys()].filter((id) => input.courseLessonIds!.has(id)).length : 0;
  const percent = lessonsTotal > 0 ? Math.round((lessonsDone * 100) / lessonsTotal) : 0;

  const submissions = {
    total: input.submissions.length,
    waiting: input.submissions.filter((row) => row.status === 'SUBMITTED').length,
    needsRevision: input.submissions.filter((row) => row.status === 'NEEDS_REVISION').length,
    completed: input.submissions.filter((row) => row.status === 'COMPLETED').length,
  };

  const lastActivityAt = latestOf([
    ...input.completed.values(),
    ...input.submissions.flatMap((row) => (row.lastVersionAt ? [row.lastVersionAt] : [])),
  ]);

  // Before she has done anything, "quiet" is counted from the day she joined or the cohort started, whichever is later.
  const base = input.enrolledAt.getTime() > input.cohortStartsOn.getTime() ? input.enrolledAt : input.cohortStartsOn;
  const reference = lastActivityAt && lastActivityAt.getTime() > base.getTime() ? lastActivityAt : base;

  const deadlines = input.submissions.flatMap((row) => (row.status === 'NEEDS_REVISION' && row.revisionOpenUntil ? [row.revisionOpenUntil] : []));
  const revisionDeadline = deadlines.length === 0 ? null : new Date(Math.min(...deadlines.map((date) => date.getTime())));

  return {
    lessonsDone,
    lessonsTotal,
    percent,
    submissions,
    lastActivityAt,
    status: studentStatus({ waitingForReview: submissions.waiting, revisionDeadline, lastActivityAt: reference, now: input.now }),
  };
}

/** The average of whole-number percentages, rounded (0 when there are no students). */
export function averagePercent(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
