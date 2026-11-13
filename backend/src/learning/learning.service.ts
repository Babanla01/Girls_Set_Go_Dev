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

import type { AuthenticatedUser } from '../auth/auth.types';
import { formatCalendarDate } from '../catalog/catalog.util';
import type { Snapshot } from '../course-content/snapshot';
import type { DbClient } from '../common/types/db-client';
import { PrismaService } from '../prisma/prisma.service';
import type { VideoPositionDto } from './dto/video-position.dto';
import { LearningAccessService, LearningContext } from './learning-access.service';
import {
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
import { ProgressStateService } from './progress-state.service';
import { PublishedCourseService } from './published-course.service';

@Injectable()
export class LearningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
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
      const state = await this.progress.load(tx, context.enrollmentId, snapshot);
      const before = this.progress.evaluate(snapshot, state);

      const found = locateLesson(before, lessonId);
      if (!found) throw new NotFoundException('Lesson not found.');
      this.assertWeekOpen(found.week);

      // Completion time is never overwritten, so pressing the button again changes nothing.
      const newlyCompleted = !state.completed.has(lessonId);
      if (newlyCompleted) {
        await tx.$executeRaw`
          INSERT INTO "lesson_progress" ("id", "enrollment_id", "lesson_id", "completed_at", "updated_at")
          VALUES (gen_random_uuid(), ${context.enrollmentId}::uuid, ${lessonId}::uuid, now(), now())
          ON CONFLICT ("enrollment_id", "lesson_id")
          DO UPDATE SET "completed_at" = COALESCE("lesson_progress"."completed_at", EXCLUDED."completed_at"),
                        "updated_at"   = now()
        `;
        state.completed.add(lessonId);
      }

      const after = this.progress.evaluate(snapshot, state);

      // Weeks that just opened: remember it, so they stay open whatever happens to the course later.
      const justOpened = await this.progress.recordOpenings(tx, context.enrollmentId, before, after);

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
    const state = await this.progress.load(db, context.enrollmentId, snapshot);
    return this.progress.evaluate(snapshot, state, context.readOnly);
  }
}