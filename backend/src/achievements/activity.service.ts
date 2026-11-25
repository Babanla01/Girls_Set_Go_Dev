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
