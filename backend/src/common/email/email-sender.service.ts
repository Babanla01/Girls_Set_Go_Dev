/**
 * email-sender.service.ts
 * ---------------------------------------------------------------------------
 * Sends the emails waiting in the outbox.
 *
 * How one round works (processBatch):
 *   1. CLAIM a few waiting emails in one database step. Claiming bumps the
 *      attempt counter and pushes "next attempt" a few minutes ahead, like
 *      borrowing a library book: if this program crashes mid-send, the email
 *      simply becomes available again later. Two senders running at once can
 *      never grab the same email (rows are claimed with SKIP LOCKED).
 *   2. Build the message from its template and send it by SMTP.
 *   3. Success  -> mark it SENT and wipe its stored values (they may contain
 *                  a one-time link). The recipient address stays, as a record.
 *      Failure  -> try again later (after 1 minute, then 15 minutes), and give up
 *                  (FAILED) after 3 attempts. A failed email shows on the page
 *                  of the thing it belongs to, where an admin can retry it.
 *      A template that does not exist or cannot be built -> FAILED at once.
 *
 * An email is delivered AT LEAST once: in the rare case that it is sent but
 * the program dies before recording that, it will be sent again.
 */
import { Injectable, Logger } from '@nestjs/common';
import { EmailStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { renderEmail } from './email.templates';
import { MailTransport } from './mail.transport';

/** Give up after this many attempts. */
export const EMAIL_MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and 3 (minutes). */
export const EMAIL_RETRY_DELAYS_MINUTES = [1, 15];
/** How long a claimed email is "borrowed" before it may be picked up again. */
export const EMAIL_LEASE_SECONDS = 300;
export const EMAIL_BATCH_SIZE = 20;

export interface SendBatchResult {
  claimed: number;
  sent: number;
  /** Failed this time but will be tried again. */
  retrying: number;
  /** Failed for good. */
  failed: number;
}

interface ClaimedEmail {
  id: string;
  toEmail: string;
  template: string;
  payload: unknown;
  attempts: number;
}

@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transport: MailTransport,
  ) {}

  async processBatch(limit: number = EMAIL_BATCH_SIZE): Promise<SendBatchResult> {
    const claimed = await this.claim(limit);
    const result: SendBatchResult = { claimed: claimed.length, sent: 0, retrying: 0, failed: 0 };

    for (const email of claimed) {
      const outcome = await this.deliver(email);
      result[outcome] += 1;
    }

    return result;
  }

  // ----------------------------------------------------------------- claiming

  private async claim(limit: number): Promise<ClaimedEmail[]> {
    return this.prisma.$queryRaw<ClaimedEmail[]>(Prisma.sql`
      UPDATE "email_outbox"
         SET "attempts" = "attempts" + 1,
             "next_attempt_at" = NOW() + (${EMAIL_LEASE_SECONDS}::double precision * INTERVAL '1 second')
       WHERE "id" IN (
         SELECT "id" FROM "email_outbox"
          WHERE "status" = 'PENDING' AND "next_attempt_at" <= NOW()
          ORDER BY "next_attempt_at", "created_at"
          LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
       )
   RETURNING "id", "to_email" AS "toEmail", "template", "payload", "attempts"
    `);
  }

  // ----------------------------------------------------------------- delivery

  private async deliver(email: ClaimedEmail): Promise<'sent' | 'retrying' | 'failed'> {
    const message = renderEmail(email.template, email.payload);
    if (!message) {
      await this.markFailed(email.id, `Cannot build the "${email.template}" email (unknown template or missing link).`);
      this.logger.error(`Email ${email.id}: cannot build template "${email.template}".`);
      return 'failed';
    }

    try {
      await this.transport.send({ to: email.toEmail, ...message });
    } catch (error) {
      return this.handleSendError(email, error);
    }

    // Wipe the stored values: they may hold a one-time link that has now been used up.
    await this.prisma.emailOutbox.update({
      where: { id: email.id },
      data: { status: EmailStatus.SENT, sentAt: new Date(), payload: {}, lastError: null },
    });
    return 'sent';
  }

  private async handleSendError(email: ClaimedEmail, error: unknown): Promise<'retrying' | 'failed'> {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);

    if (email.attempts >= EMAIL_MAX_ATTEMPTS) {
      await this.markFailed(email.id, reason);
      this.logger.error(`Email ${email.id} (${email.template}) gave up after ${email.attempts} attempts.`);
      return 'failed';
    }

    const delayMinutes =
      EMAIL_RETRY_DELAYS_MINUTES[Math.min(email.attempts - 1, EMAIL_RETRY_DELAYS_MINUTES.length - 1)];
    await this.prisma.emailOutbox.update({
      where: { id: email.id },
      data: {
        status: EmailStatus.PENDING,
        lastError: reason,
        nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
      },
    });
    this.logger.warn(`Email ${email.id} (${email.template}) failed, will retry in ${delayMinutes} minute(s).`);
    return 'retrying';
  }

  private async markFailed(id: string, reason: string): Promise<void> {
    await this.prisma.emailOutbox.update({
      where: { id },
      data: { status: EmailStatus.FAILED, lastError: reason.slice(0, 500) },
    });
  }
}