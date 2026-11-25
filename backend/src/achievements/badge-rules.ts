/**
 * badge-rules.ts
 * ---------------------------------------------------------------------------
 * WHO HAS EARNED WHICH BADGE, as one pure function (no database): give it the facts about a
 * student's learning and it says which badges are earned and WHEN.
 *
 *   WELCOME_ABOARD    she joined a cohort                       -> the day she was enrolled
 *   FIRST_SUBMISSION  she sent her first assignment             -> when she sent it
 *   ON_TIME           she sent a version BEFORE its due time    -> when she sent it
 *                     (a week with no class date has no due time, so it cannot earn this)
 *   FEEDBACK_LOOP     she sent a NEW version after the one before it had been reviewed
 *                                                               -> when she sent that version
 *   HALFWAY_THERE     Week 4 is finished: every lesson complete AND its assignment reviewed
 *                     (a course shorter than 4 weeks cannot earn it)
 *                                                               -> when the last of those happened
 *   SHOWCASE_READY    the final week's assignment (the "capstone") was marked COMPLETED
 *                                                               -> when it was marked
 *
 * The time of each badge is the time of the real event, so a catch-up for a student who already
 * had progress gives honest dates.
 */
import { BadgeKeyValue, HALFWAY_WEEK } from './badge-catalog';

export type OutcomeValue = 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';

export interface VersionFact {
  submissionId: string;
  assignmentId: string;
  number: number;
  createdAt: Date;
  isLate: boolean;
  /** The due time that applied to this version (null when its week had no class date). */
  dueAt: Date | null;
}

export interface ReviewFact {
  submissionId: string;
  versionNumber: number;
  assignmentId: string;
  outcome: OutcomeValue;
  createdAt: Date;
  editedAt: Date | null;
}

/** The shape of the LIVE course: for each week, its lessons and its assignment (if any). */
export interface CourseShape {
  weeks: { lessonIds: string[]; assignmentId: string | null }[];
}

export interface BadgeFacts {
  enrolledAt: Date;
  versions: readonly VersionFact[];
  reviews: readonly ReviewFact[];
  /** lesson id -> when she completed it. */
  completedLessons: ReadonlyMap<string, Date>;
  /** null when nothing is published for her cohort yet. */
  course: CourseShape | null;
}

const earliest = (dates: readonly Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.min(...dates.map((date) => date.getTime())));

const latest = (dates: readonly Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.max(...dates.map((date) => date.getTime())));

/** The badges earned (and when). `only` limits the work to the badges that are still wanted. */
export function evaluateBadges(facts: BadgeFacts, only?: ReadonlySet<BadgeKeyValue>): Map<BadgeKeyValue, Date> {
  const earned = new Map<BadgeKeyValue, Date>();
  const wants = (key: BadgeKeyValue): boolean => !only || only.has(key);

  if (wants('WELCOME_ABOARD')) earned.set('WELCOME_ABOARD', facts.enrolledAt);

  if (wants('FIRST_SUBMISSION')) {
    const first = earliest(facts.versions.map((version) => version.createdAt));
    if (first) earned.set('FIRST_SUBMISSION', first);
  }

  if (wants('ON_TIME')) {
    const onTime = earliest(
      facts.versions
        .filter((version) => !version.isLate && version.dueAt !== null && version.createdAt.getTime() <= version.dueAt.getTime())
        .map((version) => version.createdAt),
    );
    if (onTime) earned.set('ON_TIME', onTime);
  }

  if (wants('FEEDBACK_LOOP')) {
    const looped = earliest(
      facts.versions
        .filter((version) => {
          if (version.number < 2) return false;
          const before = facts.reviews.find(
            (review) => review.submissionId === version.submissionId && review.versionNumber === version.number - 1,
          );
          return before !== undefined && before.createdAt.getTime() < version.createdAt.getTime();
        })
        .map((version) => version.createdAt),
    );
    if (looped) earned.set('FEEDBACK_LOOP', looped);
  }

  const weeks = facts.course?.weeks ?? [];

  if (wants('HALFWAY_THERE')) {
    const week = weeks[HALFWAY_WEEK - 1];
    if (week && (week.lessonIds.length > 0 || week.assignmentId)) {
      const done = week.lessonIds.map((id) => facts.completedLessons.get(id));
      if (done.every((date): date is Date => date !== undefined)) {
        const moments: Date[] = [...(done as Date[])];
        let reviewed = true;
        if (week.assignmentId) {
          const first = earliest(facts.reviews.filter((review) => review.assignmentId === week.assignmentId).map((review) => review.createdAt));
          if (first) moments.push(first);
          else reviewed = false;
        }
        const when = latest(moments);
        if (reviewed && when) earned.set('HALFWAY_THERE', when);
      }
    }
  }

  if (wants('SHOWCASE_READY')) {
    const capstone = weeks.length > 0 ? weeks[weeks.length - 1].assignmentId : null;
    if (capstone) {
      const completed = earliest(
        facts.reviews
          .filter((review) => review.assignmentId === capstone && review.outcome === 'COMPLETED')
          .map((review) => review.editedAt ?? review.createdAt),
      );
      if (completed) earned.set('SHOWCASE_READY', completed);
    }
  }

  return earned;
}
