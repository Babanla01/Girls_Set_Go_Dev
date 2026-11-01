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
