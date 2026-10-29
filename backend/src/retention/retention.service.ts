/**
 * retention.service.ts
 * ---------------------------------------------------------------------------
 * Removes the personal details of applicants whose application was DECLINED
 * more than two months ago.
 *
 * For each such applicant, in ONE all-or-nothing database transaction:
 *   - the profile (date of birth, phone, school, guardian...) is deleted;
 *   - the application answers, the private decision note and the personal
 *     note written for the decline email are wiped;
 *   - the account is anonymised and disabled (name and email replaced, no
 *     password, no sessions, no pending links);
 *   - emails queued TO her old address, and the emails linked to her application
 *     (which includes the copies that went to her guardian), are deleted from the outbox;
 *   - one audit entry is written (ids only, no personal details).
 *
 * Safe to run as often as you like: an applicant already processed is never
 * touched again, and one who was reopened or enrolled meanwhile is skipped.
 * One applicant failing never stops the others: it is counted, logged, left
 * exactly as it was (the transaction is rolled back) and retried next run.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ApplicationStatus, AccountStatus, Prisma, Role } from '@prisma/client';

import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  monthsBefore,
  REMOVED_ACCOUNT_EMAIL_DOMAIN,
  REMOVED_ACCOUNT_NAME,
  REMOVED_TEXT,
  removedAccountEmail,
  RETENTION_BATCH_SIZE,
  RETENTION_MONTHS,
} from './retention.constants';

export interface RetentionResult {
  /** Applicants whose personal data was removed in this run. */
  removed: number;
  /** Applicants that turned out not to be due after all (changed in the meantime). */
  skipped: number;
  /** Applicants where something went wrong. Nothing was changed for them; the next run tries again. */
  failed: number;
}

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Declined before this moment = due for removal. */
  cutoff(now: Date = new Date()): Date {
    return monthsBefore(now, RETENTION_MONTHS);
  }

  /** How many applicants are due right now (changes nothing). */
  async countDue(now: Date = new Date()): Promise<number> {
    return this.prisma.studentApplication.count({ where: this.dueWhere(now) });
  }

  /**
   * Removes the data of every applicant who is due.
   * Each applicant is attempted at most ONCE per run: one that fails is left
   * exactly as it was and is simply tried again on the next run.
   */
  async removeDue(now: Date = new Date(), batchSize: number = RETENTION_BATCH_SIZE): Promise<RetentionResult> {
    const result: RetentionResult = { removed: 0, skipped: 0, failed: 0 };
    const attempted: string[] = [];

    for (;;) {
      const batch = await this.prisma.studentApplication.findMany({
        where: { ...this.dueWhere(now), id: { notIn: attempted } },
        orderBy: [{ reviewedAt: 'asc' }, { id: 'asc' }],
        take: batchSize,
        select: { id: true, studentId: true, student: { select: { email: true } } },
      });
      if (batch.length === 0) break;

      for (const candidate of batch) {
        attempted.push(candidate.id);
        try {
          if (await this.removeOne(candidate, now)) {
            result.removed += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          result.failed += 1;
          this.logger.error(`Could not remove the data for application ${candidate.id}: ${(error as Error).message}`);
        }
      }
    }

    this.logger.log(
      `Retention run finished: ${result.removed} removed, ${result.skipped} skipped, ${result.failed} failed.`,
    );
    return result;
  }

  // ----------------------------------------------------------------- helpers

  /** Which applications are due: declined long enough ago, not yet processed, nobody enrolled. */
  private dueWhere(now: Date): Prisma.StudentApplicationWhereInput {
    return {
      status: ApplicationStatus.DECLINED,
      reviewedAt: { lt: this.cutoff(now) },
      student: {
        role: Role.STUDENT,
        NOT: { email: { endsWith: `@${REMOVED_ACCOUNT_EMAIL_DOMAIN}` } },
        enrollments: { none: {} },
      },
    };
  }

  private async removeOne(
    candidate: { id: string; studentId: string; student: { email: string } },
    now: Date,
  ): Promise<boolean> {
    const originalEmail = candidate.student.email;

    return this.prisma.$transaction(async (tx) => {
      // Claim it in ONE atomic step: if it was reopened, enrolled or already
      // processed a moment ago, this finds nothing and we skip it.
      const claimed = await tx.studentApplication.updateMany({
        where: { id: candidate.id, whyJoin: { not: REMOVED_TEXT }, ...this.dueWhere(now) },
        data: { whyJoin: REMOVED_TEXT, hopeToLearn: REMOVED_TEXT, stemExperience: null, decisionNote: null, personalNote: null },
      });
      if (claimed.count !== 1) return false;

      await tx.studentProfile.deleteMany({ where: { userId: candidate.studentId } });
      await tx.emailOutbox.deleteMany({
        where: {
          OR: [{ toEmail: originalEmail }, { entityType: 'student_application', entityId: candidate.id }],
        },
      });
      await tx.authToken.deleteMany({ where: { userId: candidate.studentId } });
      await tx.session.deleteMany({ where: { userId: candidate.studentId } });

      await tx.user.update({
        where: { id: candidate.studentId },
        data: {
          email: removedAccountEmail(candidate.studentId),
          fullName: REMOVED_ACCOUNT_NAME,
          passwordHash: null,
          status: AccountStatus.SUSPENDED,
          emailVerifiedAt: null,
          lastLoginAt: null,
        },
      });

      await this.audit.record(
        {
          actorId: null,
          action: 'application.personal_data_removed',
          entityType: 'student_application',
          entityId: candidate.id,
          metadata: { studentId: candidate.studentId },
        },
        tx,
      );
      return true;
    });
  }
}