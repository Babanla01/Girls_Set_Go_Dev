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
