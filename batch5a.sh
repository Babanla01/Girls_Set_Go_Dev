#!/usr/bin/env bash
# Batch 5A - badges and the activity feed. Run from the repo root.
set -euo pipefail
cd backend
mkdir -p prisma/migrations/20261120000000_activity_and_badges src/achievements/dto

# ============================================================================
cat > prisma/migrations/20261120000000_activity_and_badges/migration.sql <<'EOF'
-- Batch 5A: the student's activity feed and badges.
--
--   activity_events  an APPEND-ONLY log of what happened in a student's learning: she joined her
--                    cohort, completed a lesson, sent a submission, received a review, earned a
--                    badge. The activity feed is read from it. Each event has a unique key, so the
--                    same thing is never logged twice (the one-time catch-up for students who
--                    already had progress, and the live recording, can overlap safely).
--   student_badges   the badges a student has earned, and when. Never changed or removed.
--
-- Both belong to an ENROLLMENT, like the rest of her progress. They hold ids and small facts
-- only - never feedback text or scores.
-- Written by hand (CHECK rules and a trigger); names follow Prisma's conventions.

CREATE TYPE "ActivityType" AS ENUM ('ENROLLED', 'LESSON_COMPLETED', 'SUBMISSION_SENT', 'REVIEW_RECEIVED', 'BADGE_EARNED');

CREATE TYPE "BadgeKey" AS ENUM (
  'WELCOME_ABOARD', 'FIRST_SUBMISSION', 'ON_TIME', 'FEEDBACK_LOOP', 'HALFWAY_THERE', 'SHOWCASE_READY'
);

-- ---------------------------------------------------------------------------
CREATE TABLE "activity_events" (
  "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id" UUID           NOT NULL,
  "type"          "ActivityType" NOT NULL,
  -- Says WHAT this event is about ("lesson:<id>", "version:<id>", "review:<id>", "badge:<KEY>", "enrolled").
  "ref_key"       VARCHAR(100)   NOT NULL,
  -- When it really happened (not when it was logged).
  "occurred_at"   TIMESTAMPTZ(3) NOT NULL,
  "details"       JSONB          NOT NULL DEFAULT '{}',
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_events_ref_key_check" CHECK (btrim("ref_key") <> ''),
  CONSTRAINT "activity_events_details_check" CHECK (jsonb_typeof("details") = 'object')
);

CREATE UNIQUE INDEX "activity_events_enrollment_id_type_ref_key_key" ON "activity_events"("enrollment_id", "type", "ref_key");
CREATE INDEX "activity_events_enrollment_id_occurred_at_idx" ON "activity_events"("enrollment_id", "occurred_at");

ALTER TABLE "activity_events"
  ADD CONSTRAINT "activity_events_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
CREATE TABLE "student_badges" (
  "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id" UUID           NOT NULL,
  "badge"         "BadgeKey"     NOT NULL,
  "earned_at"     TIMESTAMPTZ(3) NOT NULL,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "student_badges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "student_badges_enrollment_id_badge_key" ON "student_badges"("enrollment_id", "badge");

ALTER TABLE "student_badges"
  ADD CONSTRAINT "student_badges_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- HAND-WRITTEN rule: the log and the badges are append-only. Nothing is ever changed or deleted.
CREATE FUNCTION "activity_records_refuse_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be changed or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "activity_events_append_only"
  BEFORE UPDATE OR DELETE ON "activity_events"
  FOR EACH ROW EXECUTE FUNCTION "activity_records_refuse_change"();
CREATE TRIGGER "student_badges_append_only"
  BEFORE UPDATE OR DELETE ON "student_badges"
  FOR EACH ROW EXECUTE FUNCTION "activity_records_refuse_change"();
EOF

# ============================================================================
cat > src/achievements/badge-catalog.ts <<'EOF'
/**
 * badge-catalog.ts
 * ---------------------------------------------------------------------------
 * The six badges: their names and the plain-English "how to earn" shown to students.
 * (The rules that decide who has earned one are in badge-rules.ts.)
 */

export const BADGE_KEYS = [
  'WELCOME_ABOARD',
  'FIRST_SUBMISSION',
  'ON_TIME',
  'FEEDBACK_LOOP',
  'HALFWAY_THERE',
  'SHOWCASE_READY',
] as const;

export type BadgeKeyValue = (typeof BADGE_KEYS)[number];

export interface BadgeInfo {
  key: BadgeKeyValue;
  name: string;
  /** "How to earn" - shown for badges she has not earned yet. */
  howToEarn: string;
}

/** "Halfway there" is earned by finishing this week of the course. */
export const HALFWAY_WEEK = 4;

export const BADGES: readonly BadgeInfo[] = [
  { key: 'WELCOME_ABOARD', name: 'Welcome aboard', howToEarn: 'Join a cohort.' },
  { key: 'FIRST_SUBMISSION', name: 'First submission', howToEarn: 'Send in your first assignment.' },
  { key: 'ON_TIME', name: 'On time', howToEarn: 'Send an assignment before its due time.' },
  { key: 'FEEDBACK_LOOP', name: 'Feedback loop', howToEarn: 'Send a new version after you get feedback.' },
  {
    key: 'HALFWAY_THERE',
    name: 'Halfway there',
    howToEarn: `Finish Week ${HALFWAY_WEEK}: complete its lessons and get its assignment reviewed.`,
  },
  { key: 'SHOWCASE_READY', name: 'Showcase ready', howToEarn: "Get your final week's assignment marked complete." },
];

export const badgeInfo = (key: string): BadgeInfo | undefined => BADGES.find((badge) => badge.key === key);
EOF

# ============================================================================
cat > src/achievements/badge-rules.ts <<'EOF'
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
EOF

# ============================================================================
cat > src/achievements/activity-text.ts <<'EOF'
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
EOF

# ============================================================================
cat > src/achievements/dto/activity.query.ts <<'EOF'
/**
 * activity.query.ts - paging for the activity feed:  ?page=1&pageSize=20
 */
import { PaginationQueryDto } from '../../common/pagination/pagination';

export class ActivityQuery extends PaginationQueryDto {}
EOF

# ============================================================================
cat > src/achievements/activity.service.ts <<'EOF'
/**
 * activity.service.ts
 * ---------------------------------------------------------------------------
 * The student's ACTIVITY LOG and feed.
 *
 *  - Every important thing in a student's learning is written to an APPEND-ONLY log (the
 *    database refuses to change or delete a row): joining her cohort, completing a lesson,
 *    sending a submission, receiving a review, earning a badge.
 *  - The log is written IN THE SAME TRANSACTION as the action itself, so an event is never
 *    lost and never recorded for something that was rolled back.
 *  - Every event has a unique key (for example "lesson:<id>"), so recording the same thing twice
 *    is harmless: the second attempt is simply ignored.
 *  - Events hold ids and small facts only - never feedback text or scores.
 *  - A student who already had progress before this feature existed gets a ONE-TIME CATCH-UP
 *    from what is already stored (with the real dates), the first time she opens her feed.
 */
import { Injectable } from '@nestjs/common';
import { ActivityType, Prisma } from '@prisma/client';

import { buildPage, toSkipTake } from '../common/pagination/pagination';
import type { DbClient } from '../common/types/db-client';
import { PublishedCourseService } from '../learning/published-course.service';
import { PrismaService } from '../prisma/prisma.service';
import { describeEvent } from './activity-text';
import type { ActivityQuery } from './dto/activity.query';

export interface NewEvent {
  enrollmentId: string;
  type: ActivityType;
  /** What the event is about; with the type it makes the event unique. */
  refKey: string;
  occurredAt: Date;
  details: Prisma.InputJsonObject;
}

const toRow = (event: NewEvent): Prisma.ActivityEventCreateManyInput => ({
  enrollmentId: event.enrollmentId,
  type: event.type,
  refKey: event.refKey,
  occurredAt: event.occurredAt,
  details: event.details,
});

@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly published: PublishedCourseService,
  ) {}

  /** Writes one event (ignored if the same event is already there). Use the transaction's client inside a transaction. */
  async record(db: DbClient, event: NewEvent): Promise<void> {
    await db.activityEvent.createMany({ data: [toRow(event)], skipDuplicates: true });
  }

  async recordMany(db: DbClient, events: readonly NewEvent[]): Promise<void> {
    if (events.length === 0) return;
    await db.activityEvent.createMany({ data: events.map(toRow), skipDuplicates: true });
  }

  /** The feed: newest first, paginated, each event as a plain-English line. */
  async feed(enrollmentId: string, query: ActivityQuery) {
    const [total, rows] = await Promise.all([
      this.prisma.activityEvent.count({ where: { enrollmentId } }),
      this.prisma.activityEvent.findMany({
        where: { enrollmentId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        ...toSkipTake(query),
        select: { id: true, type: true, occurredAt: true, details: true },
      }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      type: row.type,
      occurredAt: row.occurredAt,
      text: describeEvent(row.type, row.details),
    }));
    return buildPage(items, total, query);
  }

  /**
   * The one-time catch-up: if this enrollment's log has never been started (no "enrolled"
   * event), fill it from what is already stored - lessons completed, versions sent, reviews
   * received - with their real dates. It is idempotent, and after it runs the live recording
   * keeps the log up to date.
   */
  async ensureBackfilled(enrollmentId: string): Promise<void> {
    const started = await this.prisma.activityEvent.findFirst({
      where: { enrollmentId, type: ActivityType.ENROLLED },
      select: { id: true },
    });
    if (started) return;

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: {
        enrolledAt: true,
        cohort: { select: { name: true, courseContent: { select: { id: true, publishedVersion: true } } } },
      },
    });
    if (!enrollment) return;

    // Titles for the lines, from the live course (best effort: an item that no longer exists just has no title).
    const content = enrollment.cohort.courseContent;
    const live =
      content && content.publishedVersion !== null ? await this.published.get(content.id, content.publishedVersion).catch(() => null) : null;
    const lessonInfo = new Map<string, { title: string; weekPosition: number }>();
    const assignmentTitle = new Map<string, string>();
    live?.weeks.forEach((week, weekIndex) => {
      week.lessons.forEach((lesson) => lessonInfo.set(lesson.id, { title: lesson.title, weekPosition: weekIndex + 1 }));
      if (week.assignment) assignmentTitle.set(week.assignment.id, week.assignment.title);
    });

    const [lessons, versions, reviews] = await Promise.all([
      this.prisma.lessonProgress.findMany({
        where: { enrollmentId, completedAt: { not: null } },
        select: { lessonId: true, completedAt: true },
      }),
      this.prisma.submissionVersion.findMany({
        where: { submission: { enrollmentId } },
        select: {
          id: true,
          number: true,
          isLate: true,
          createdAt: true,
          submission: { select: { assignmentId: true } },
          _count: { select: { files: true } },
        },
      }),
      this.prisma.submissionReview.findMany({
        where: { version: { submission: { enrollmentId } } },
        select: { id: true, outcome: true, createdAt: true, version: { select: { submission: { select: { assignmentId: true } } } } },
      }),
    ]);

    const events: NewEvent[] = [
      {
        enrollmentId,
        type: ActivityType.ENROLLED,
        refKey: 'enrolled',
        occurredAt: enrollment.enrolledAt,
        details: { cohortName: enrollment.cohort.name },
      },
      ...lessons.flatMap((row) => {
        if (!row.completedAt) return [];
        const info = lessonInfo.get(row.lessonId);
        return [
          {
            enrollmentId,
            type: ActivityType.LESSON_COMPLETED,
            refKey: `lesson:${row.lessonId}`,
            occurredAt: row.completedAt,
            details: { lessonId: row.lessonId, lessonTitle: info?.title ?? '', weekPosition: info?.weekPosition ?? 0 },
          },
        ];
      }),
      ...versions.map((row) => ({
        enrollmentId,
        type: ActivityType.SUBMISSION_SENT,
        refKey: `version:${row.id}`,
        occurredAt: row.createdAt,
        details: {
          assignmentId: row.submission.assignmentId,
          assignmentTitle: assignmentTitle.get(row.submission.assignmentId) ?? '',
          version: row.number,
          files: row._count.files,
          late: row.isLate,
        },
      })),
      ...reviews.map((row) => ({
        enrollmentId,
        type: ActivityType.REVIEW_RECEIVED,
        refKey: `review:${row.id}`,
        occurredAt: row.createdAt,
        details: {
          assignmentId: row.version.submission.assignmentId,
          assignmentTitle: assignmentTitle.get(row.version.submission.assignmentId) ?? '',
          outcome: row.outcome,
        },
      })),
    ];

    await this.recordMany(this.prisma, events);
  }
}
EOF

# ============================================================================
cat > src/achievements/badges.service.ts <<'EOF'
/**
 * badges.service.ts
 * ---------------------------------------------------------------------------
 * Awarding and listing badges.
 *
 *  - The rules live in badge-rules.ts (pure). This service gathers the facts from the database,
 *    asks the rules which badges are earned, and saves the new ones - together with a
 *    "badge earned" event in the activity log, in ONE transaction.
 *  - Awarding is IDEMPOTENT: a badge is stored once (the database refuses a second copy), so it
 *    is safe to run after every lesson, submission or review, and when the student opens her
 *    badges page. A badge is never taken back.
 *  - Only the badges NOT yet earned are worked out, so a student who has them all costs one query.
 *  - After an action (a lesson, a submission, a review) the check runs QUIETLY: if anything goes
 *    wrong it is logged and the action itself is never affected.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ActivityType } from '@prisma/client';

import { scheduleFor } from '../learning/assignment-rules';
import { PublishedCourseService } from '../learning/published-course.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from './activity.service';
import { BADGE_KEYS, BADGES, BadgeKeyValue, badgeInfo } from './badge-catalog';
import { BadgeFacts, CourseShape, evaluateBadges } from './badge-rules';

@Injectable()
export class BadgesService {
  private readonly log = new Logger(BadgesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly published: PublishedCourseService,
    private readonly activity: ActivityService,
  ) {}

  /** Awards every wanted badge that is now earned; returns the ones that are new. */
  async sync(enrollmentId: string, only?: readonly BadgeKeyValue[]): Promise<BadgeKeyValue[]> {
    const have = await this.prisma.studentBadge.findMany({ where: { enrollmentId }, select: { badge: true } });
    const owned = new Set<string>(have.map((row) => row.badge));
    const wanted = BADGE_KEYS.filter((key) => !owned.has(key) && (!only || only.includes(key)));
    if (wanted.length === 0) return [];

    const facts = await this.loadFacts(enrollmentId);
    if (!facts) return [];

    const earned = evaluateBadges(facts, new Set(wanted));
    if (earned.size === 0) return [];

    const rows = [...earned].map(([badge, earnedAt]) => ({ enrollmentId, badge, earnedAt }));
    await this.prisma.$transaction(async (tx) => {
      await tx.studentBadge.createMany({ data: rows, skipDuplicates: true });
      await this.activity.recordMany(
        tx,
        rows.map((row) => ({
          enrollmentId,
          type: ActivityType.BADGE_EARNED,
          refKey: `badge:${row.badge}`,
          occurredAt: row.earnedAt,
          details: { badge: row.badge },
        })),
      );
    });
    return rows.map((row) => row.badge);
  }

  /** The same, for use right after an action: a problem here is logged and never reaches the student. */
  async syncQuietly(enrollmentId: string, only?: readonly BadgeKeyValue[]): Promise<void> {
    try {
      await this.sync(enrollmentId, only);
    } catch (error) {
      this.log.warn(`Badge check failed for enrollment ${enrollmentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Earned badges (with dates) and the ones still to earn (with "how to earn"). */
  async list(enrollmentId: string) {
    await this.activity.ensureBackfilled(enrollmentId);
    await this.sync(enrollmentId);

    const rows = await this.prisma.studentBadge.findMany({
      where: { enrollmentId },
      orderBy: [{ earnedAt: 'asc' }, { id: 'asc' }],
      select: { badge: true, earnedAt: true },
    });
    const earnedKeys = new Set<string>(rows.map((row) => row.badge));

    const earned = rows.flatMap((row) => {
      const info = badgeInfo(row.badge);
      return info ? [{ key: info.key, name: info.name, earnedAt: row.earnedAt }] : [];
    });
    const upcoming = BADGES.filter((badge) => !earnedKeys.has(badge.key)).map((badge) => ({
      key: badge.key,
      name: badge.name,
      howToEarn: badge.howToEarn,
    }));

    return { earned, upcoming, counts: { earned: earned.length, total: BADGES.length } };
  }

  // ----------------------------------------------------------------- helpers

  /** Gathers the facts the badge rules need (a handful of quick queries). */
  private async loadFacts(enrollmentId: string): Promise<BadgeFacts | null> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: { enrolledAt: true, cohort: { select: { courseContent: { select: { id: true, publishedVersion: true } } } } },
    });
    if (!enrollment) return null;
    const content = enrollment.cohort.courseContent;

    const [versions, reviews, lessons] = await Promise.all([
      this.prisma.submissionVersion.findMany({
        where: { submission: { enrollmentId } },
        select: { number: true, isLate: true, createdAt: true, courseVersion: true, submission: { select: { id: true, assignmentId: true } } },
      }),
      this.prisma.submissionReview.findMany({
        where: { version: { submission: { enrollmentId } } },
        select: {
          submissionId: true,
          versionNumber: true,
          outcome: true,
          createdAt: true,
          editedAt: true,
          version: { select: { submission: { select: { assignmentId: true } } } },
        },
      }),
      this.prisma.lessonProgress.findMany({
        where: { enrollmentId, completedAt: { not: null } },
        select: { lessonId: true, completedAt: true },
      }),
    ]);

    // The due time each version had, from the course version she answered.
    const dueByVersion = new Map<number, Map<string, Date | null>>();
    if (content) {
      for (const courseVersion of new Set(versions.map((version) => version.courseVersion))) {
        const snapshot = await this.published.get(content.id, courseVersion).catch(() => null);
        const byAssignment = new Map<string, Date | null>();
        snapshot?.weeks.forEach((week) => {
          if (week.assignment) {
            byAssignment.set(week.assignment.id, scheduleFor(week.classSession ? new Date(week.classSession.startsAt) : null).dueAt);
          }
        });
        dueByVersion.set(courseVersion, byAssignment);
      }
    }

    // The live course, for "Week 4" and the final week.
    const live =
      content && content.publishedVersion !== null ? await this.published.get(content.id, content.publishedVersion).catch(() => null) : null;
    const course: CourseShape | null = live
      ? { weeks: live.weeks.map((week) => ({ lessonIds: week.lessons.map((lesson) => lesson.id), assignmentId: week.assignment?.id ?? null })) }
      : null;

    return {
      enrolledAt: enrollment.enrolledAt,
      versions: versions.map((version) => ({
        submissionId: version.submission.id,
        assignmentId: version.submission.assignmentId,
        number: version.number,
        createdAt: version.createdAt,
        isLate: version.isLate,
        dueAt: dueByVersion.get(version.courseVersion)?.get(version.submission.assignmentId) ?? null,
      })),
      reviews: reviews.map((review) => ({
        submissionId: review.submissionId,
        versionNumber: review.versionNumber,
        assignmentId: review.version.submission.assignmentId,
        outcome: review.outcome,
        createdAt: review.createdAt,
        editedAt: review.editedAt,
      })),
      completedLessons: new Map(lessons.flatMap((row) => (row.completedAt ? [[row.lessonId, row.completedAt] as const] : []))),
      course,
    };
  }
}
EOF

# ============================================================================
cat > src/achievements/achievements.service.ts <<'EOF'
/**
 * achievements.service.ts  (the student's side)
 * ---------------------------------------------------------------------------
 * A student's badges and activity feed. They belong to her ENROLLMENT: the one she is learning
 * in now, or - once she has finished - the most recent one she completed. Anyone without an
 * enrollment (pending, declined, never applied) gets the same plain 403 as the course screens.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { NOT_OPEN_MESSAGE } from '../learning/learning.constants';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from './activity.service';
import { BadgesService } from './badges.service';
import type { ActivityQuery } from './dto/activity.query';

@Injectable()
export class AchievementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly badges: BadgesService,
    private readonly activity: ActivityService,
  ) {}

  async myBadges(user: AuthenticatedUser) {
    return this.badges.list(await this.enrollmentIdOf(user));
  }

  async myActivity(user: AuthenticatedUser, query: ActivityQuery) {
    const enrollmentId = await this.enrollmentIdOf(user);
    await this.activity.ensureBackfilled(enrollmentId);
    // Badges earned by past progress should appear in the feed the first time she looks.
    await this.badges.syncQuietly(enrollmentId);
    return this.activity.feed(enrollmentId, query);
  }

  /** Her active enrollment, else the most recently completed one. */
  private async enrollmentIdOf(user: AuthenticatedUser): Promise<string> {
    const enrollment =
      (await this.prisma.enrollment.findFirst({ where: { studentId: user.id, status: EnrollmentStatus.ACTIVE }, select: { id: true } })) ??
      (await this.prisma.enrollment.findFirst({
        where: { studentId: user.id, status: EnrollmentStatus.COMPLETED },
        orderBy: [{ endedAt: 'desc' }, { id: 'asc' }],
        select: { id: true },
      }));
    if (!enrollment) throw new ForbiddenException(NOT_OPEN_MESSAGE);
    return enrollment.id;
  }
}
EOF

cat > src/achievements/achievements.controller.ts <<'EOF'
/**
 * achievements.controller.ts
 * ---------------------------------------------------------------------------
 * A student's badges and activity feed (students only).
 *
 *   GET /api/v1/learn/badges                   earned badges (with dates) and the ones still to earn ("how to earn")
 *   GET /api/v1/learn/activity?page=&pageSize= her recent activity, newest first
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AchievementsService } from './achievements.service';
import { ActivityQuery } from './dto/activity.query';

@Roles(Role.STUDENT)
@Controller('learn')
export class AchievementsController {
  constructor(private readonly achievements: AchievementsService) {}

  @Get('badges')
  badges(@CurrentUser() user: AuthenticatedUser) {
    return this.achievements.myBadges(user);
  }

  @Get('activity')
  activity(@CurrentUser() user: AuthenticatedUser, @Query() query: ActivityQuery) {
    return this.achievements.myActivity(user, query);
  }
}
EOF

cat > src/achievements/achievements.module.ts <<'EOF'
/**
 * achievements.module.ts
 * ---------------------------------------------------------------------------
 * Badges and the activity log. The learning and grading modules import it so that lessons,
 * submissions and reviews are recorded (ActivityService) and badges are awarded (BadgesService).
 * It depends only on the published-course reader, never on the learning module itself, so the
 * modules do not depend on each other in a circle.
 */
import { Module } from '@nestjs/common';

import { PublishedCourseModule } from '../learning/published-course.module';
import { AchievementsController } from './achievements.controller';
import { AchievementsService } from './achievements.service';
import { ActivityService } from './activity.service';
import { BadgesService } from './badges.service';

@Module({
  imports: [PublishedCourseModule],
  controllers: [AchievementsController],
  providers: [ActivityService, BadgesService, AchievementsService],
  exports: [ActivityService, BadgesService],
})
export class AchievementsModule {}
EOF

# ============================================================================
cat > src/learning/published-course.module.ts <<'EOF'
/**
 * published-course.module.ts
 * ---------------------------------------------------------------------------
 * Reads the LIVE published version of a course copy (with a small in-memory cache). It is its
 * own tiny module so the learning, grading and achievements modules can all share ONE cache
 * without depending on each other in a circle.
 */
import { Module } from '@nestjs/common';

import { PublishedCourseService } from './published-course.service';

@Module({
  providers: [PublishedCourseService],
  exports: [PublishedCourseService],
})
export class PublishedCourseModule {}
EOF

cat > src/learning/learning.module.ts <<'EOF'
/**
 * learning.module.ts
 * ---------------------------------------------------------------------------
 * The student's learning experience: the course overview, lessons, completion,
 * video resume, assignments and submissions, and opening a week early for one student.
 *
 * It relies on the ownership rule registered by CourseContentModule
 * ("course-content.manage") for the early-open action, so both modules must be
 * part of the application (they are, in AppModule). File storage and signed links come
 * from the shared PlatformModule (src/platform), which is global.
 *
 * It uses AchievementsModule to record activity and award badges.
 * ProgressStateService, SubmissionFilesService and the published-course reader are exported
 * because the grading module uses them too.
 */
import { Module } from '@nestjs/common';

import { AchievementsModule } from '../achievements/achievements.module';
import { AuthModule } from '../auth/auth.module';
import { AssignmentContextService } from './assignment-context.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { EnrollmentUnlockController } from './enrollment-unlock.controller';
import { LearningAccessService } from './learning-access.service';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { ProgressStateService } from './progress-state.service';
import { PublishedCourseModule } from './published-course.module';
import { SubmissionFilesService } from './submission-files.service';
import { SubmissionsService } from './submissions.service';
import { WeekUnlockService } from './week-unlock.service';

@Module({
  imports: [AuthModule, PublishedCourseModule, AchievementsModule],
  controllers: [LearningController, AssignmentsController, EnrollmentUnlockController],
  providers: [
    LearningAccessService,
    ProgressStateService,
    LearningService,
    AssignmentContextService,
    AssignmentsService,
    SubmissionFilesService,
    SubmissionsService,
    WeekUnlockService,
  ],
  exports: [PublishedCourseModule, ProgressStateService, SubmissionFilesService],
})
export class LearningModule {}
EOF

cat > src/grading/grading.module.ts <<'EOF'
/**
 * grading.module.ts
 * ---------------------------------------------------------------------------
 * Reviewing student work: the inbox, one submission's detail, and saving reviews.
 *
 * It relies on the ownership rule registered by CourseContentModule ("course-content.manage")
 * to decide whose submissions an instructor may review, on the learning module for the shared
 * progress rules and for opening submitted files, and on the achievements module to record a
 * review in the student's activity and to award the badges a review can unlock.
 */
import { Module } from '@nestjs/common';

import { AchievementsModule } from '../achievements/achievements.module';
import { AuthModule } from '../auth/auth.module';
import { LearningModule } from '../learning/learning.module';
import { GradingController } from './grading.controller';
import { GradingScopeService } from './grading-scope.service';
import { InboxService } from './inbox.service';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [AuthModule, LearningModule, AchievementsModule],
  controllers: [GradingController],
  providers: [GradingScopeService, InboxService, ReviewsService],
})
export class GradingModule {}
EOF

echo "Batch 5A files created. Now replace the files shown below the script."