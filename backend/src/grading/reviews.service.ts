/**
 * reviews.service.ts
 * ---------------------------------------------------------------------------
 * Looking at one submission, and reviewing it.
 *
 *  DETAIL  The student's name, the assignment as she was given it (with the FULL rubric, even
 *          when students cannot see it), the due and close times, every version with its note,
 *          link and files - the files open through short-lived links made for THIS instructor
 *          only - and each version's review.
 *
 *  REVIEW  Four rubric scores (1 to 4), one strength, one next step, and the outcome:
 *            REVIEWED         feedback given
 *            NEEDS_REVISION   she may resubmit for N days (7 by default), even after the deadline
 *            COMPLETED        done - she can no longer change it
 *          - Only the LATEST version can be reviewed. If the student sent a newer one while the
 *            instructor was reading, the save is refused (409) instead of landing on the wrong work.
 *          - One review per version. Its author can edit it for 24 hours (anyone else, or later, is
 *            refused). Every save and edit goes to the audit log; a review is never deleted.
 *          - The FIRST review of a week's assignment opens the next week for the student, when her
 *            lessons are complete (any outcome counts). The opening is recorded, so it stays open.
 *          - The answer includes the next submission in the queue.
 *
 * Who: admins, and the instructors of that student's cohort (checked on every request).
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EnrollmentStatus, SubmissionReview, SubmissionStatus } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { phaseAt, scheduleFor } from '../learning/assignment-rules';
import type { WeekProgress } from '../learning/learning-rules';
import { ProgressStateService } from '../learning/progress-state.service';
import { PublishedCourseService } from '../learning/published-course.service';
import { SubmissionFilesService } from '../learning/submission-files.service';
import type { ReviewDto } from './dto/review.dto';
import { GradingScopeService } from './grading-scope.service';
import { InboxService } from './inbox.service';
import { editDecision, revisionDaysFor } from './review-rules';

const DAY_MS = 86_400_000;

const scoresOf = (row: Pick<SubmissionReview, 'scoreUnderstanding' | 'scoreExecution' | 'scoreTesting' | 'scoreCommunication'>) => ({
  understanding: row.scoreUnderstanding,
  execution: row.scoreExecution,
  testing: row.scoreTesting,
  communication: row.scoreCommunication,
});

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: GradingScopeService,
    private readonly inbox: InboxService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
    private readonly files: SubmissionFilesService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ detail

  async detail(user: AuthenticatedUser, submissionId: string) {
    const row = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        reference: true,
        status: true,
        revisionOpenUntil: true,
        assignmentId: true,
        enrollment: {
          select: {
            student: { select: { id: true, fullName: true } },
            cohort: { select: { id: true, name: true, course: { select: { id: true, title: true } }, courseContent: { select: { id: true } } } },
          },
        },
        versions: {
          orderBy: { number: 'asc' },
          select: {
            number: true,
            isLate: true,
            courseVersion: true,
            linkUrl: true,
            note: true,
            createdAt: true,
            files: {
              orderBy: { position: 'asc' },
              select: { file: { select: { id: true, originalName: true, contentType: true, sizeBytes: true, storageKey: true } } },
            },
            review: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Submission not found.');
    await this.scope.assertCanGrade(user, row.enrollment.cohort.id);

    const latest = row.versions[row.versions.length - 1];
    const now = new Date();

    // The assignment exactly as the student was given it (the course version she answered).
    const contentId = row.enrollment.cohort.courseContent?.id;
    const snapshot = contentId && latest ? await this.published.get(contentId, latest.courseVersion) : null;
    const weekIndex = snapshot ? snapshot.weeks.findIndex((week) => week.assignment?.id === row.assignmentId) : -1;
    const week = snapshot && weekIndex >= 0 ? snapshot.weeks[weekIndex] : null;
    const assignment = week?.assignment ?? null;
    const schedule = scheduleFor(week?.classSession ? new Date(week.classSession.startsAt) : null);

    const reviewerIds = [...new Set(row.versions.flatMap((version) => (version.review ? [version.review.reviewerId] : [])))];
    const reviewers = reviewerIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, fullName: true } })
      : [];
    const reviewerName = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer.fullName]));

    return {
      id: row.id,
      reference: row.reference,
      status: row.status,
      revisionOpenUntil: row.revisionOpenUntil,
      student: row.enrollment.student,
      cohort: { id: row.enrollment.cohort.id, name: row.enrollment.cohort.name },
      course: row.enrollment.cohort.course,
      assignment: assignment
        ? {
            id: assignment.id,
            title: assignment.title,
            brief: assignment.brief,
            includes: assignment.includes,
            successEvidence: assignment.successEvidence,
            expectedMinutes: assignment.expectedMinutes,
            allowedFileTypes: assignment.allowedFileTypes,
            // Instructors always see the whole rubric; this says whether the STUDENT can.
            rubric: assignment.rubric,
            rubricVisibleToStudent: assignment.rubricVisible,
          }
        : { id: row.assignmentId, title: 'Assignment' },
      week: week ? { id: week.id, position: weekIndex + 1, title: week.title } : null,
      schedule: {
        timezone: schedule.timezone,
        dueAt: schedule.dueAt,
        closesAt: schedule.closesAt,
        phase: phaseAt(schedule, now),
      },
      versions: row.versions.map((version) => ({
        number: version.number,
        submittedAt: version.createdAt,
        isLate: version.isLate,
        courseVersion: version.courseVersion,
        linkUrl: version.linkUrl,
        note: version.note,
        // Links made for THIS instructor only; they work for a few minutes.
        files: version.files.map(({ file }) => ({
          id: file.id,
          name: file.originalName,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          url: this.files.linkFor(file, user.id),
        })),
        review: version.review ? this.reviewView(version.review, reviewerName.get(version.review.reviewerId) ?? 'Unknown', user, now) : null,
      })),
      latestVersion: latest?.number ?? 0,
      nextInQueue: await this.inbox.nextWaiting(user, row.id),
    };
  }

  // -------------------------------------------------------------------- save

  async save(user: AuthenticatedUser, submissionId: string, dto: ReviewDto, requestContext: RequestContext) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        enrollment: {
          select: { id: true, status: true, cohort: { select: { id: true, courseContent: { select: { id: true, publishedVersion: true } } } } },
        },
      },
    });
    if (!submission) throw new NotFoundException('Submission not found.');
    const { enrollment } = submission;
    await this.scope.assertCanGrade(user, enrollment.cohort.id);

    const revision = revisionDaysFor(dto.outcome, dto.revisionDays);
    if (revision.problem) throw new BadRequestException(revision.problem);

    // The live course, to work out which week this review opens (none if nothing is published).
    const content = enrollment.cohort.courseContent;
    const live = content && content.publishedVersion !== null ? await this.published.get(content.id, content.publishedVersion) : null;

    const saved = await this.prisma.$transaction(async (tx) => {
      // Take turns with the student (a new version) and with other reviewers.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "submissions" WHERE "id" = ${submissionId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Submission not found.');

      const current = await tx.submission.findUniqueOrThrow({
        where: { id: submissionId },
        select: { versions: { orderBy: { number: 'desc' }, take: 1, select: { number: true } } },
      });
      const latest = current.versions[0]?.number;
      if (latest === undefined) throw new ConflictException('This submission has no versions to review.');
      if (dto.versionNumber > latest) throw new NotFoundException(`Version ${dto.versionNumber} not found.`);
      if (dto.versionNumber < latest) throw new ConflictException('The student sent a newer version. Reload and review the latest one.');

      const existing = await tx.submissionReview.findUnique({
        where: { submissionId_versionNumber: { submissionId, versionNumber: latest } },
      });
      const now = new Date();
      if (existing) {
        const decision = editDecision({ reviewerId: existing.reviewerId, userId: user.id, createdAt: existing.createdAt, now });
        if (!decision.allowed) {
          if (decision.blockedBy === 'AUTHOR') throw new ForbiddenException(decision.reason);
          throw new ConflictException(decision.reason);
        }
      }

      // Which weeks are open BEFORE this review counts.
      const learning = live !== null && enrollment.status === EnrollmentStatus.ACTIVE ? live : null;
      const before = learning ? this.progress.evaluate(learning, await this.progress.load(tx, enrollment.id, learning)) : null;

      const data = {
        scoreUnderstanding: dto.scores.understanding,
        scoreExecution: dto.scores.execution,
        scoreTesting: dto.scores.testing,
        scoreCommunication: dto.scores.communication,
        strength: dto.strength,
        nextStep: dto.nextStep,
        outcome: dto.outcome,
        revisionDays: revision.days,
      };
      const review = existing
        ? await tx.submissionReview.update({ where: { id: existing.id }, data: { ...data, editedAt: now } })
        : await tx.submissionReview.create({ data: { submissionId, versionNumber: latest, reviewerId: user.id, ...data } });

      const updated = await tx.submission.update({
        where: { id: submissionId },
        data: {
          status: SubmissionStatus[dto.outcome],
          revisionOpenUntil: revision.days ? new Date(now.getTime() + revision.days * DAY_MS) : null,
        },
        select: { reference: true, status: true, revisionOpenUntil: true },
      });

      // The first review opens the next week (when her lessons are complete); remember it.
      let opened: WeekProgress[] = [];
      if (learning && before) {
        const after = this.progress.evaluate(learning, await this.progress.load(tx, enrollment.id, learning));
        opened = await this.progress.recordOpenings(tx, enrollment.id, before, after);
      }

      await this.audit.record(
        {
          actorId: user.id,
          action: existing ? 'submission.review_edited' : 'submission.reviewed',
          entityType: 'submission',
          entityId: submissionId,
          metadata: { version: latest, outcome: dto.outcome, openedWeeks: opened.map((week) => week.position) },
          previousValue: existing ? { outcome: existing.outcome, scores: scoresOf(existing) } : undefined,
          newValue: { outcome: review.outcome, scores: scoresOf(review) },
          ipAddress: requestContext.ipAddress,
        },
        tx,
      );

      return { review, updated, opened, edited: existing !== null };
    });

    return {
      edited: saved.edited,
      review: this.reviewView(saved.review, user.fullName, user, new Date()),
      submission: { id: submissionId, reference: saved.updated.reference, status: saved.updated.status, revisionOpenUntil: saved.updated.revisionOpenUntil },
      openedWeeks: saved.opened.map((week) => ({ id: week.id, position: week.position, title: week.title })),
      nextInQueue: await this.inbox.nextWaiting(user, submissionId),
    };
  }

  // ----------------------------------------------------------------- helpers

  private reviewView(review: SubmissionReview, reviewerName: string, user: AuthenticatedUser, now: Date) {
    return {
      id: review.id,
      versionNumber: review.versionNumber,
      scores: scoresOf(review),
      strength: review.strength,
      nextStep: review.nextStep,
      outcome: review.outcome,
      revisionDays: review.revisionDays,
      reviewedAt: review.createdAt,
      editedAt: review.editedAt,
      reviewer: { id: review.reviewerId, fullName: reviewerName },
      /** true while this person is the author and the 24 hours have not passed. */
      canEdit: editDecision({ reviewerId: review.reviewerId, userId: user.id, createdAt: review.createdAt, now }).allowed,
    };
  }
}
