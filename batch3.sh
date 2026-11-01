#!/usr/bin/env bash
# Batch 3 - the student's learning experience. Run from the repo root.
set -euo pipefail
cd backend
mkdir -p prisma/migrations/20261031000000_student_learning src/learning/dto

# ============================================================================
cat > prisma/migrations/20261031000000_student_learning/migration.sql <<'EOF'
-- Batch 3: the student's learning progress.
--
--   lesson_progress  one row per (enrollment, lesson): when she completed it, and where she
--                    paused the video ("Resume from 03:12").
--   week_unlocks     the weeks that are OPEN for an enrollment because of progress, or because
--                    an instructor / admin opened one early. Once a week has been opened for a
--                    student it STAYS open, even if lessons are added to the course later.
--
-- IMPORTANT: lesson_id and week_id deliberately have NO foreign key. They are the permanent ids
-- of items in a PUBLISHED course version, which never change; the draft tables the editor
-- rewrites (restore / discard) can therefore never delete a student's progress.
-- Written by hand (CHECK rules); names follow Prisma's conventions.

CREATE TYPE "WeekUnlockSource" AS ENUM ('PROGRESS', 'EARLY_OPEN');

-- ---------------------------------------------------------------------------
CREATE TABLE "lesson_progress" (
  "id"                     UUID           NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id"          UUID           NOT NULL,
  "lesson_id"              UUID           NOT NULL,
  "completed_at"           TIMESTAMPTZ(3),
  "video_block_id"         UUID,
  "video_position_seconds" INTEGER,
  "created_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lesson_progress_video_position_check"
    CHECK ("video_position_seconds" IS NULL OR "video_position_seconds" BETWEEN 0 AND 86400),
  CONSTRAINT "lesson_progress_video_pair_check"
    CHECK (("video_block_id" IS NULL) = ("video_position_seconds" IS NULL))
);

CREATE UNIQUE INDEX "lesson_progress_enrollment_id_lesson_id_key" ON "lesson_progress"("enrollment_id", "lesson_id");
CREATE INDEX "lesson_progress_lesson_id_idx" ON "lesson_progress"("lesson_id");

ALTER TABLE "lesson_progress"
  ADD CONSTRAINT "lesson_progress_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
CREATE TABLE "week_unlocks" (
  "id"             UUID               NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id"  UUID               NOT NULL,
  "week_id"        UUID               NOT NULL,
  "source"         "WeekUnlockSource" NOT NULL,
  "unlocked_by_id" UUID,
  "reason"         VARCHAR(300),
  "created_at"     TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "week_unlocks_pkey" PRIMARY KEY ("id"),
  -- An early opening always says WHO opened it and WHY; an opening caused by progress has neither.
  CONSTRAINT "week_unlocks_early_open_check"
    CHECK (("source" = 'EARLY_OPEN') = ("unlocked_by_id" IS NOT NULL)
       AND ("source" = 'EARLY_OPEN') = ("reason" IS NOT NULL))
);

CREATE UNIQUE INDEX "week_unlocks_enrollment_id_week_id_key" ON "week_unlocks"("enrollment_id", "week_id");

ALTER TABLE "week_unlocks"
  ADD CONSTRAINT "week_unlocks_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EOF

# ============================================================================
cat > src/learning/learning.constants.ts <<'EOF'
/**
 * learning.constants.ts
 * ---------------------------------------------------------------------------
 * The wording and limits of the student's learning screens, in ONE place.
 * (The wording comes from the design guide.)
 */

/** Shown (403) to anyone who has no place in a cohort: pending, declined or never applied. No course details leak. */
export const NOT_OPEN_MESSAGE =
  "This course isn't open for you yet. Courses unlock after the Girls Set Go team accepts your application and places you in a track and cohort.";

/** Shown when her cohort has a course but nobody has published it yet. */
export const NOT_READY_MESSAGE = "Your course content isn't ready yet. Your instructor will publish it soon.";

/** Shown to a student who finished the course: she can read everything but cannot change progress. */
export const READ_ONLY_MESSAGE = 'You have completed this course, so it is read-only now.';

export const cohortNotStartedMessage = (startsOn: string): string =>
  `Your cohort starts on ${startsOn}. Your course will open then.`;

/** The longest video the position can point into (24 hours of seconds). */
export const MAX_VIDEO_SECONDS = 86_400;
EOF

# ============================================================================
cat > src/learning/learning-rules.ts <<'EOF'
/**
 * learning-rules.ts
 * ---------------------------------------------------------------------------
 * The RULES of the student's course, as pure functions (no database), so they are
 * easy to read and to test on their own.
 *
 *   WEEKS OPEN ONE AT A TIME
 *     - Week 1 is open from the start.
 *     - A later week opens when the PREVIOUS week's lessons are all complete.
 *       (Batch 4 adds "and its assignment is graded" through `gradedWeeks`.)
 *     - A week an instructor opened early, and a week that has already been opened
 *       for her, stay open ("unlocked").
 *     - Inside an open week, lessons can be done in any order.
 *     - A student who completed the course sees every week open (read-only).
 *
 *   PROGRESS
 *     - lessons done / total lessons, as a whole-number percentage;
 *     - weeks completed = open weeks whose lessons are all done.
 *
 * Only lessons that exist in the published version count, so a lesson removed from
 * the live course simply stops counting.
 */
import type { Snapshot } from '../course-content/snapshot';

export type WeekStatus = 'LOCKED' | 'IN_PROGRESS' | 'COMPLETE';

export interface LockedReason {
  code: 'PREVIOUS_WEEK_INCOMPLETE';
  /** The sentence shown to the student (and returned with the 403 for a locked lesson). */
  message: string;
  previousWeek: { position: number; title: string };
  lessonsRemaining: number;
}

export interface LessonProgressView {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  estimatedMinutes: number | null;
  completed: boolean;
}

export interface WeekProgress {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  status: WeekStatus;
  open: boolean;
  lessonsDone: number;
  lessonsTotal: number;
  lockedReason: LockedReason | null;
  lessons: LessonProgressView[];
}

export interface EvaluateOptions {
  /** Ids of the lessons she completed. */
  completed: ReadonlySet<string>;
  /** Ids of the weeks already opened for her (by progress or early). */
  unlocked: ReadonlySet<string>;
  /** Every week counts as open (a student who finished the course). */
  allOpen?: boolean;
  /** Batch 4: weeks whose assignment has been graded. When given, it is required to open the next week. */
  gradedWeeks?: ReadonlySet<string>;
}

export const lockedMessage = (previousPosition: number): string =>
  `Opens after the Week ${previousPosition} lessons are complete.`;

/** Works out, for every week of the published course, whether it is open and how far she got. */
export function evaluateWeeks(snapshot: Snapshot, options: EvaluateOptions): WeekProgress[] {
  const weeks: WeekProgress[] = [];

  snapshot.weeks.forEach((week, index) => {
    const lessons: LessonProgressView[] = week.lessons.map((lesson, lessonIndex) => ({
      id: lesson.id,
      position: lessonIndex + 1,
      title: lesson.title,
      summary: lesson.summary,
      estimatedMinutes: lesson.estimatedMinutes,
      completed: options.completed.has(lesson.id),
    }));
    const lessonsDone = lessons.filter((lesson) => lesson.completed).length;
    const lessonsTotal = lessons.length;

    const previous = index > 0 ? weeks[index - 1] : null;
    const previousFinished =
      previous === null ||
      (previous.lessonsDone === previous.lessonsTotal && (!options.gradedWeeks || options.gradedWeeks.has(previous.id)));
    const open = options.allOpen === true || previousFinished || options.unlocked.has(week.id);

    weeks.push({
      id: week.id,
      position: index + 1,
      title: week.title,
      summary: week.summary,
      open,
      status: !open ? 'LOCKED' : lessonsDone === lessonsTotal ? 'COMPLETE' : 'IN_PROGRESS',
      lessonsDone,
      lessonsTotal,
      lockedReason:
        open || previous === null
          ? null
          : {
              code: 'PREVIOUS_WEEK_INCOMPLETE',
              message: lockedMessage(previous.position),
              previousWeek: { position: previous.position, title: previous.title },
              lessonsRemaining: previous.lessonsTotal - previous.lessonsDone,
            },
      lessons,
    });
  });

  return weeks;
}

export interface ProgressSummary {
  lessonsDone: number;
  lessonsTotal: number;
  /** Whole number, 0 to 100 (0 when the course has no lessons yet). */
  percent: number;
  weeksCompleted: number;
  weeksTotal: number;
}

export function summarizeProgress(weeks: readonly WeekProgress[]): ProgressSummary {
  const lessonsDone = weeks.reduce((total, week) => total + week.lessonsDone, 0);
  const lessonsTotal = weeks.reduce((total, week) => total + week.lessonsTotal, 0);
  return {
    lessonsDone,
    lessonsTotal,
    percent: lessonsTotal === 0 ? 0 : Math.round((lessonsDone * 100) / lessonsTotal),
    weeksCompleted: weeks.filter((week) => week.status === 'COMPLETE' && week.lessonsTotal > 0).length,
    weeksTotal: weeks.length,
  };
}

export interface LessonRef {
  id: string;
  title: string;
  weekId: string;
  weekPosition: number;
}

/** The lessons she can open right now, in course order. */
export function openLessons(weeks: readonly WeekProgress[]): (LessonRef & { completed: boolean })[] {
  return weeks
    .filter((week) => week.open)
    .flatMap((week) =>
      week.lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        weekId: week.id,
        weekPosition: week.position,
        completed: lesson.completed,
      })),
    );
}

/**
 * "Continue learning": the first lesson she has not completed. When `afterLessonId`
 * is given, it looks after that lesson first (and then from the start).
 */
export function findNextLesson(weeks: readonly WeekProgress[], afterLessonId?: string): LessonRef | null {
  const lessons = openLessons(weeks);
  const start = afterLessonId ? lessons.findIndex((lesson) => lesson.id === afterLessonId) + 1 : 0;

  const pending = (lesson: (typeof lessons)[number]) => !lesson.completed && lesson.id !== afterLessonId;
  const next = lessons.slice(start).find(pending) ?? lessons.slice(0, start).find(pending);
  return next ? { id: next.id, title: next.title, weekId: next.weekId, weekPosition: next.weekPosition } : null;
}

/** The lessons just before and after one lesson in course order (only lessons she can open). */
export function neighbours(weeks: readonly WeekProgress[], lessonId: string): { previous: LessonRef | null; next: LessonRef | null } {
  const lessons = openLessons(weeks);
  const index = lessons.findIndex((lesson) => lesson.id === lessonId);
  const ref = (lesson: (typeof lessons)[number] | undefined): LessonRef | null =>
    lesson ? { id: lesson.id, title: lesson.title, weekId: lesson.weekId, weekPosition: lesson.weekPosition } : null;
  return { previous: index > 0 ? ref(lessons[index - 1]) : null, next: index >= 0 ? ref(lessons[index + 1]) : null };
}

/** Finds a lesson (and its week) by id. */
export function locateLesson(weeks: readonly WeekProgress[], lessonId: string): { week: WeekProgress; lesson: LessonProgressView } | null {
  for (const week of weeks) {
    const lesson = week.lessons.find((candidate) => candidate.id === lessonId);
    if (lesson) return { week, lesson };
  }
  return null;
}
EOF

# ============================================================================
cat > src/learning/published-course.service.ts <<'EOF'
/**
 * published-course.service.ts
 * ---------------------------------------------------------------------------
 * Reads the PUBLISHED (live) version of a course copy.
 *
 * A published version never changes, so once it is read it can be kept in memory
 * for as long as the server runs: every student request after the first one is
 * served without touching the database for the (potentially large) course
 * snapshot. The cache keeps the most recently used versions and forgets the rest.
 * Nothing can go stale: a new publish simply has a new version number.
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import { parseSnapshot, Snapshot } from '../course-content/snapshot';
import { PrismaService } from '../prisma/prisma.service';

/** How many published versions to keep in memory at once. */
const CACHE_SIZE = 32;

@Injectable()
export class PublishedCourseService {
  private readonly cache = new Map<string, Snapshot>();

  constructor(private readonly prisma: PrismaService) {}

  async get(contentId: string, version: number): Promise<Snapshot> {
    const key = `${contentId}:${version}`;

    const cached = this.cache.get(key);
    if (cached) {
      // Mark it as recently used (a Map remembers the order things were put in).
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const row = await this.prisma.courseVersion.findUnique({
      where: { contentId_number: { contentId, number: version } },
      select: { snapshot: true },
    });
    if (!row) throw new NotFoundException('The published course could not be found.');

    const snapshot = parseSnapshot(row.snapshot);
    this.cache.set(key, snapshot);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    return snapshot;
  }
}
EOF

# ============================================================================
cat > src/learning/learning-access.service.ts <<'EOF'
/**
 * learning-access.service.ts
 * ---------------------------------------------------------------------------
 * Decides what course (if any) a student may open RIGHT NOW. It runs on every
 * request and reads the database each time, so access ends the moment an admin
 * withdraws her or moves her.
 *
 *   NO_ENROLLMENT   no place in a cohort (pending, declined, withdrawn, never applied)
 *   NOT_STARTED     she is accepted, but her cohort has not started yet
 *   NOT_READY       her cohort's course has nothing published yet
 *   READY           she may learn (ACTIVE enrollment) or read (COMPLETED enrollment, read-only)
 *
 * Course access comes ONLY from an enrollment, never from an application or a flag.
 */
import { Injectable } from '@nestjs/common';
import { CohortStatus, EnrollmentStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

export interface CohortInfo {
  id: string;
  name: string;
  startsOn: Date;
  endsOn: Date;
}

export interface LearningContext {
  enrollmentId: string;
  /** true for a student who completed the course: everything is readable, nothing can change. */
  readOnly: boolean;
  cohort: CohortInfo;
  /** The course copy of her cohort and its LIVE version. */
  contentId: string;
  version: number;
}

export type LearningAccess =
  | { kind: 'NO_ENROLLMENT' }
  | { kind: 'NOT_STARTED'; cohort: CohortInfo }
  | { kind: 'NOT_READY'; cohort: CohortInfo }
  | { kind: 'READY'; context: LearningContext };

const enrollmentSelect = {
  id: true,
  status: true,
  cohort: {
    select: {
      id: true,
      name: true,
      status: true,
      startsOn: true,
      endsOn: true,
      courseContent: { select: { id: true, publishedVersion: true } },
    },
  },
} as const;

@Injectable()
export class LearningAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: AuthenticatedUser): Promise<LearningAccess> {
    // At most one enrollment is ACTIVE; otherwise use the most recently finished one.
    const enrollment =
      (await this.prisma.enrollment.findFirst({
        where: { studentId: user.id, status: EnrollmentStatus.ACTIVE },
        select: enrollmentSelect,
      })) ??
      (await this.prisma.enrollment.findFirst({
        where: { studentId: user.id, status: EnrollmentStatus.COMPLETED },
        orderBy: [{ endedAt: 'desc' }, { id: 'asc' }],
        select: enrollmentSelect,
      }));
    if (!enrollment) return { kind: 'NO_ENROLLMENT' };

    const { cohort } = enrollment;
    const info: CohortInfo = { id: cohort.id, name: cohort.name, startsOn: cohort.startsOn, endsOn: cohort.endsOn };

    if (enrollment.status === EnrollmentStatus.ACTIVE && cohort.status === CohortStatus.PLANNED) {
      return { kind: 'NOT_STARTED', cohort: info };
    }

    const content = cohort.courseContent;
    if (!content || content.publishedVersion === null) return { kind: 'NOT_READY', cohort: info };

    return {
      kind: 'READY',
      context: {
        enrollmentId: enrollment.id,
        readOnly: enrollment.status === EnrollmentStatus.COMPLETED,
        cohort: info,
        contentId: content.id,
        version: content.publishedVersion,
      },
    };
  }
}
EOF

# ============================================================================
cat > src/learning/dto/video-position.dto.ts <<'EOF'
/**
 * video-position.dto.ts - where the student paused a video ("Resume from 03:12").
 */
import { IsInt, IsUUID, Max, Min } from 'class-validator';

import { MAX_VIDEO_SECONDS } from '../learning.constants';

export class VideoPositionDto {
  /** The video block inside the lesson. */
  @IsUUID()
  blockId!: string;

  /** Seconds from the start of the video. */
  @IsInt()
  @Min(0)
  @Max(MAX_VIDEO_SECONDS)
  seconds!: number;
}
EOF

cat > src/learning/dto/early-open.dto.ts <<'EOF'
/**
 * early-open.dto.ts - an instructor or admin opening a week early for ONE student.
 */
import { Transform } from 'class-transformer';
import { IsString, IsUUID, Length } from 'class-validator';

import { cleanLabel } from '../../catalog/catalog.util';

export class EarlyOpenDto {
  /** The week to open (its id in the published course). */
  @IsUUID()
  weekId!: string;

  /** Why it is being opened early. It is kept with the opening, so it can be reviewed later. */
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(3, 300)
  reason!: string;
}
EOF

# ============================================================================
cat > src/learning/learning.service.ts <<'EOF'
/**
 * learning.service.ts
 * ---------------------------------------------------------------------------
 * The student's side of the course: the overview, one lesson, "Mark complete &
 * continue", and the video resume position.
 *
 * Principles:
 *  - STUDENTS ONLY EVER SEE THE LIVE PUBLISHED VERSION of their own cohort's course.
 *    Drafts never reach them, and blocks marked "instructor only" are removed here,
 *    on the server, before anything is sent.
 *  - THE SERVER DECIDES WHAT IS OPEN. A locked week's lesson address answers 403
 *    with the same explanation as the week list, so nothing can be reached by
 *    guessing a link.
 *  - COMPLETION IS MANUAL and permanent ("Mark complete & continue"); pressing it
 *    twice is safe. It is separate from assignment grading.
 *  - A WEEK STAYS OPEN once it has opened: when the student finishes a week's last
 *    lesson, the opening of the next week is recorded, so adding lessons to the course
 *    later can never lock her out again.
 *  - Progress belongs to the ENROLLMENT and points at lesson ids of the published
 *    version (no links to draft rows), so editing, restoring or discarding the draft
 *    can never delete it.
 */
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { WeekUnlockSource } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { formatCalendarDate } from '../catalog/catalog.util';
import type { Snapshot } from '../course-content/snapshot';
import type { DbClient } from '../common/types/db-client';
import { PrismaService } from '../prisma/prisma.service';
import type { VideoPositionDto } from './dto/video-position.dto';
import { LearningAccessService, LearningContext } from './learning-access.service';
import {
  evaluateWeeks,
  findNextLesson,
  locateLesson,
  neighbours,
  summarizeProgress,
  WeekProgress,
} from './learning-rules';
import {
  cohortNotStartedMessage,
  NOT_OPEN_MESSAGE,
  NOT_READY_MESSAGE,
  READ_ONLY_MESSAGE,
} from './learning.constants';
import { PublishedCourseService } from './published-course.service';

@Injectable()
export class LearningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly published: PublishedCourseService,
  ) {}

  // ---------------------------------------------------------------- overview

  /** The course overview: weeks with their state, lessons with ticks, and her progress. */
  async getCourse(user: AuthenticatedUser) {
    const access = await this.access.resolve(user);

    if (access.kind === 'NO_ENROLLMENT') throw new ForbiddenException(NOT_OPEN_MESSAGE);
    if (access.kind === 'NOT_STARTED') {
      return {
        state: 'COHORT_NOT_STARTED' as const,
        message: cohortNotStartedMessage(formatCalendarDate(access.cohort.startsOn)),
        cohort: { id: access.cohort.id, name: access.cohort.name, startsOn: formatCalendarDate(access.cohort.startsOn) },
      };
    }
    if (access.kind === 'NOT_READY') {
      return { state: 'CONTENT_NOT_READY' as const, message: NOT_READY_MESSAGE, cohort: { id: access.cohort.id, name: access.cohort.name } };
    }

    const { context } = access;
    const snapshot = await this.published.get(context.contentId, context.version);
    const weeks = await this.weeksFor(this.prisma, context, snapshot);

    return {
      state: context.readOnly ? ('COMPLETED' as const) : ('LEARNING' as const),
      readOnly: context.readOnly,
      cohort: { id: context.cohort.id, name: context.cohort.name },
      version: context.version,
      progress: summarizeProgress(weeks),
      nextLesson: findNextLesson(weeks),
      weeks: weeks.map((week) => ({
        id: week.id,
        position: week.position,
        title: week.title,
        summary: week.summary,
        status: week.status,
        lessonsDone: week.lessonsDone,
        lessonsTotal: week.lessonsTotal,
        lockedReason: week.lockedReason,
        // A locked week shows only its title and why it is locked - not its lessons.
        lessons: week.open ? week.lessons : [],
      })),
    };
  }

  // ------------------------------------------------------------------ lesson

  /** One lesson with its blocks (instructor-only blocks removed), her place in it, and the lessons around it. */
  async getLesson(user: AuthenticatedUser, lessonId: string) {
    const context = await this.requireReady(user);
    const snapshot = await this.published.get(context.contentId, context.version);
    const weeks = await this.weeksFor(this.prisma, context, snapshot);

    const found = locateLesson(weeks, lessonId);
    if (!found) throw new NotFoundException('Lesson not found.');
    this.assertWeekOpen(found.week);

    const stored = await this.prisma.lessonProgress.findUnique({
      where: { enrollmentId_lessonId: { enrollmentId: context.enrollmentId, lessonId } },
      select: { completedAt: true, videoBlockId: true, videoPositionSeconds: true },
    });

    const lesson = snapshot.weeks.flatMap((week) => week.lessons).find((candidate) => candidate.id === lessonId);
    const blocks = (lesson?.blocks ?? [])
      .filter((block) => !block.instructorOnly) // never sent to students
      .map((block, index) => ({ id: block.id, position: index + 1, type: block.type, data: block.data }));

    return {
      lesson: {
        id: found.lesson.id,
        title: found.lesson.title,
        summary: found.lesson.summary,
        estimatedMinutes: found.lesson.estimatedMinutes,
        position: found.lesson.position,
        completed: found.lesson.completed,
        completedAt: stored?.completedAt ?? null,
      },
      week: {
        id: found.week.id,
        position: found.week.position,
        title: found.week.title,
        lessonsDone: found.week.lessonsDone,
        lessonsTotal: found.week.lessonsTotal,
      },
      blocks,
      video:
        stored?.videoBlockId && stored.videoPositionSeconds !== null
          ? { blockId: stored.videoBlockId, positionSeconds: stored.videoPositionSeconds }
          : null,
      readOnly: context.readOnly,
      navigation: neighbours(weeks, lessonId),
    };
  }

  // ---------------------------------------------------------------- complete

  /**
   * "Mark complete & continue". Safe to press twice. When it finishes a week, the next
   * week opens and its opening is recorded.
   */
  async complete(user: AuthenticatedUser, lessonId: string) {
    const context = await this.requireReady(user);
    if (context.readOnly) throw new ForbiddenException(READ_ONLY_MESSAGE);
    const snapshot = await this.published.get(context.contentId, context.version);

    return this.prisma.$transaction(async (tx) => {
      const { completed, unlocked } = await this.loadProgress(tx, context.enrollmentId);
      const before = evaluateWeeks(snapshot, { completed, unlocked });

      const found = locateLesson(before, lessonId);
      if (!found) throw new NotFoundException('Lesson not found.');
      this.assertWeekOpen(found.week);

      // Completion time is never overwritten, so pressing the button again changes nothing.
      const newlyCompleted = !completed.has(lessonId);
      if (newlyCompleted) {
        await tx.$executeRaw`
          INSERT INTO "lesson_progress" ("id", "enrollment_id", "lesson_id", "completed_at", "updated_at")
          VALUES (gen_random_uuid(), ${context.enrollmentId}::uuid, ${lessonId}::uuid, now(), now())
          ON CONFLICT ("enrollment_id", "lesson_id")
          DO UPDATE SET "completed_at" = COALESCE("lesson_progress"."completed_at", EXCLUDED."completed_at"),
                        "updated_at"   = now()
        `;
        completed.add(lessonId);
      }

      const after = evaluateWeeks(snapshot, { completed, unlocked });

      // Weeks that just opened: remember it, so they stay open whatever happens to the course later.
      const justOpened = after.filter((week, index) => week.open && !before[index].open);
      if (justOpened.length > 0) {
        await tx.weekUnlock.createMany({
          data: justOpened.map((week) => ({
            enrollmentId: context.enrollmentId,
            weekId: week.id,
            source: WeekUnlockSource.PROGRESS,
          })),
          skipDuplicates: true,
        });
      }

      const stored = await tx.lessonProgress.findUniqueOrThrow({
        where: { enrollmentId_lessonId: { enrollmentId: context.enrollmentId, lessonId } },
        select: { completedAt: true },
      });
      const progress = summarizeProgress(after);
      const weekAfter = locateLesson(after, lessonId)?.week;

      return {
        lesson: { id: lessonId, completed: true, completedAt: stored.completedAt, newlyCompleted },
        weekComplete: weekAfter ? weekAfter.lessonsDone === weekAfter.lessonsTotal : false,
        openedWeeks: justOpened.map((week) => ({ id: week.id, position: week.position, title: week.title })),
        courseComplete: progress.lessonsTotal > 0 && progress.lessonsDone === progress.lessonsTotal,
        progress,
        nextLesson: findNextLesson(after, lessonId),
      };
    });
  }

  // ---------------------------------------------------------- video position

  /**
   * Remembers where she paused a video. The screen should send this every 10-15
   * seconds while playing and when she pauses or leaves (not on every frame).
   */
  async saveVideoPosition(user: AuthenticatedUser, lessonId: string, dto: VideoPositionDto) {
    const context = await this.requireReady(user);
    const snapshot = await this.published.get(context.contentId, context.version);
    const weeks = await this.weeksFor(this.prisma, context, snapshot);

    const found = locateLesson(weeks, lessonId);
    if (!found) throw new NotFoundException('Lesson not found.');
    this.assertWeekOpen(found.week);

    const lesson = snapshot.weeks.flatMap((week) => week.lessons).find((candidate) => candidate.id === lessonId);
    const video = lesson?.blocks.find((block) => block.id === dto.blockId && block.type === 'VIDEO' && !block.instructorOnly);
    if (!video) throw new NotFoundException('Video not found.');

    await this.prisma.$executeRaw`
      INSERT INTO "lesson_progress" ("id", "enrollment_id", "lesson_id", "video_block_id", "video_position_seconds", "updated_at")
      VALUES (gen_random_uuid(), ${context.enrollmentId}::uuid, ${lessonId}::uuid, ${dto.blockId}::uuid, ${dto.seconds}::int, now())
      ON CONFLICT ("enrollment_id", "lesson_id")
      DO UPDATE SET "video_block_id" = EXCLUDED."video_block_id",
                    "video_position_seconds" = EXCLUDED."video_position_seconds",
                    "updated_at" = now()
    `;
    return { saved: true as const };
  }

  // ----------------------------------------------------------------- helpers

  /** The course she may open now, or the plain-English reason she cannot. */
  private async requireReady(user: AuthenticatedUser): Promise<LearningContext> {
    const access = await this.access.resolve(user);
    switch (access.kind) {
      case 'READY':
        return access.context;
      case 'NOT_STARTED':
        throw new ForbiddenException(cohortNotStartedMessage(formatCalendarDate(access.cohort.startsOn)));
      case 'NOT_READY':
        throw new ConflictException(NOT_READY_MESSAGE);
      default:
        throw new ForbiddenException(NOT_OPEN_MESSAGE);
    }
  }

  /** A locked week answers 403 with the SAME sentence the week list shows. */
  private assertWeekOpen(week: WeekProgress): void {
    if (!week.open) throw new ForbiddenException(week.lockedReason?.message ?? 'This week is not open yet.');
  }

  private async weeksFor(db: DbClient, context: LearningContext, snapshot: Snapshot): Promise<WeekProgress[]> {
    const { completed, unlocked } = await this.loadProgress(db, context.enrollmentId);
    return evaluateWeeks(snapshot, { completed, unlocked, allOpen: context.readOnly });
  }

  /** The lessons she completed and the weeks already opened for her (two quick queries). */
  private async loadProgress(db: DbClient, enrollmentId: string): Promise<{ completed: Set<string>; unlocked: Set<string> }> {
    const [done, opened] = await Promise.all([
      db.lessonProgress.findMany({ where: { enrollmentId, completedAt: { not: null } }, select: { lessonId: true } }),
      db.weekUnlock.findMany({ where: { enrollmentId }, select: { weekId: true } }),
    ]);
    return { completed: new Set(done.map((row) => row.lessonId)), unlocked: new Set(opened.map((row) => row.weekId)) };
  }
}
EOF

# ============================================================================
cat > src/learning/week-unlock.service.ts <<'EOF'
/**
 * week-unlock.service.ts
 * ---------------------------------------------------------------------------
 * An instructor or admin opening a week EARLY for one student.
 *
 *  - Admins may do it for any student; an instructor only for a student in a cohort
 *    assigned to her (the same ownership rule as editing that cohort's course).
 *  - Only for a student who is learning right now (an ACTIVE enrollment), and only
 *    for a week that is still locked for her.
 *  - A reason is required and is kept with the opening. The action is written to the
 *    audit log (who, which student's enrollment, which week).
 *  - The week then stays open for her, like any week that opened through progress.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentKind, EnrollmentStatus, Prisma, WeekUnlockSource } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { PolicyService } from '../auth/policy/policy.service';
import { AuditService } from '../common/audit/audit.service';
import { COURSE_CONTENT_MANAGE } from '../course-content/course-content.constants';
import type { ManageResource } from '../course-content/content-editor.service';
import { PrismaService } from '../prisma/prisma.service';
import type { EarlyOpenDto } from './dto/early-open.dto';
import { evaluateWeeks } from './learning-rules';
import { PublishedCourseService } from './published-course.service';

@Injectable()
export class WeekUnlockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly published: PublishedCourseService,
  ) {}

  async openEarly(user: AuthenticatedUser, enrollmentId: string, dto: EarlyOpenDto, context: RequestContext) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: {
        id: true,
        status: true,
        cohort: { select: { id: true, courseContent: { select: { id: true, publishedVersion: true } } } },
      },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found.');

    await this.policy.assertCan<ManageResource>(user, COURSE_CONTENT_MANAGE, {
      kind: ContentKind.COHORT_COPY,
      cohortId: enrollment.cohort.id,
    });

    if (enrollment.status !== EnrollmentStatus.ACTIVE) {
      throw new ConflictException('A week can only be opened early for a student who is currently learning.');
    }
    const content = enrollment.cohort.courseContent;
    if (!content || content.publishedVersion === null) {
      throw new ConflictException("This cohort's course has not been published yet.");
    }

    const snapshot = await this.published.get(content.id, content.publishedVersion);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const [done, opened] = await Promise.all([
          tx.lessonProgress.findMany({ where: { enrollmentId, completedAt: { not: null } }, select: { lessonId: true } }),
          tx.weekUnlock.findMany({ where: { enrollmentId }, select: { weekId: true } }),
        ]);
        const weeks = evaluateWeeks(snapshot, {
          completed: new Set(done.map((row) => row.lessonId)),
          unlocked: new Set(opened.map((row) => row.weekId)),
        });

        const week = weeks.find((candidate) => candidate.id === dto.weekId);
        if (!week) throw new NotFoundException('Week not found in this course.');
        if (week.open) throw new ConflictException('That week is already open for this student.');

        const unlock = await tx.weekUnlock.create({
          data: {
            enrollmentId,
            weekId: week.id,
            source: WeekUnlockSource.EARLY_OPEN,
            unlockedById: user.id,
            reason: dto.reason,
          },
          select: { createdAt: true, reason: true },
        });

        // The audit entry holds ids only; the reason stays with the opening itself.
        await this.audit.record(
          {
            actorId: user.id,
            action: 'learning.week_opened_early',
            entityType: 'enrollment',
            entityId: enrollmentId,
            metadata: { weekId: week.id, weekPosition: week.position, cohortId: enrollment.cohort.id },
            ipAddress: context.ipAddress,
          },
          tx,
        );

        return {
          unlock: {
            weekId: week.id,
            weekPosition: week.position,
            weekTitle: week.title,
            reason: unlock.reason,
            unlockedAt: unlock.createdAt,
          },
        };
      });
    } catch (error) {
      // Two people opened the same week at the same moment: the database allows one.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That week is already open for this student.');
      }
      throw error;
    }
  }
}
EOF

# ============================================================================
cat > src/learning/learning.controller.ts <<'EOF'
/**
 * learning.controller.ts
 * ---------------------------------------------------------------------------
 * The student's course. Students only (class-level @Roles(STUDENT)); everything
 * is about the signed-in student's own cohort - there is no id of a course or a
 * cohort to guess.
 *
 *   GET /api/v1/learn/course                                the overview: weeks, lessons, progress, "continue learning"
 *   GET /api/v1/learn/lessons/:lessonId                     one lesson with its blocks (403 with the reason if its week is locked)
 *   POST /api/v1/learn/lessons/:lessonId/complete           "Mark complete & continue" (safe to press twice)
 *   PUT /api/v1/learn/lessons/:lessonId/video-position      remember where she paused a video
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { VideoPositionDto } from './dto/video-position.dto';
import { LearningService } from './learning.service';

@Roles(Role.STUDENT)
@Controller('learn')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Get('course')
  course(@CurrentUser() user: AuthenticatedUser) {
    return this.learning.getCourse(user);
  }

  @Get('lessons/:lessonId')
  lesson(@CurrentUser() user: AuthenticatedUser, @Param('lessonId', new ParseUUIDPipe()) lessonId: string) {
    return this.learning.getLesson(user, lessonId);
  }

  @Post('lessons/:lessonId/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthenticatedUser, @Param('lessonId', new ParseUUIDPipe()) lessonId: string) {
    return this.learning.complete(user, lessonId);
  }

  @Put('lessons/:lessonId/video-position')
  saveVideoPosition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
    @Body() dto: VideoPositionDto,
  ) {
    return this.learning.saveVideoPosition(user, lessonId, dto);
  }
}
EOF

cat > src/learning/enrollment-unlock.controller.ts <<'EOF'
/**
 * enrollment-unlock.controller.ts
 * ---------------------------------------------------------------------------
 * Opening a week early for ONE student (admins, and the instructor of that student's cohort).
 *
 *   POST /api/v1/enrollments/:enrollmentId/week-unlocks     body: { weekId, reason }
 */
import { Body, Controller, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { EarlyOpenDto } from './dto/early-open.dto';
import { WeekUnlockService } from './week-unlock.service';

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('enrollments')
export class EnrollmentUnlockController {
  constructor(private readonly unlocks: WeekUnlockService) {}

  @Post(':enrollmentId/week-unlocks')
  openEarly(
    @CurrentUser() user: AuthenticatedUser,
    @Param('enrollmentId', new ParseUUIDPipe()) enrollmentId: string,
    @Body() dto: EarlyOpenDto,
    @Req() req: Request,
  ) {
    return this.unlocks.openEarly(user, enrollmentId, dto, getRequestContext(req));
  }
}
EOF

# ============================================================================
cat > src/learning/learning.module.ts <<'EOF'
/**
 * learning.module.ts
 * ---------------------------------------------------------------------------
 * The student's learning experience: the course overview, lessons, completion,
 * video resume, and opening a week early for one student.
 *
 * It relies on the ownership rule registered by CourseContentModule
 * ("course-content.manage") for the early-open action, so both modules must be
 * part of the application (they are, in AppModule).
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EnrollmentUnlockController } from './enrollment-unlock.controller';
import { LearningAccessService } from './learning-access.service';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { PublishedCourseService } from './published-course.service';
import { WeekUnlockService } from './week-unlock.service';

@Module({
  imports: [AuthModule],
  controllers: [LearningController, EnrollmentUnlockController],
  providers: [LearningAccessService, PublishedCourseService, LearningService, WeekUnlockService],
  exports: [PublishedCourseService],
})
export class LearningModule {}
EOF

echo "Batch 3 files created. Now replace prisma/schema.prisma and src/app.module.ts with the versions provided."