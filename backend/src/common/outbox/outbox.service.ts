/**
 * outbox.service.ts
 * ---------------------------------------------------------------------------
 * Queues emails in the database ("outbox") instead of sending them directly.
 *
 * Why: the email row is written in the SAME transaction as the action that
 * causes it. So an email can never be lost if the server crashes, and is never
 * sent for something that was rolled back. A background worker (a later batch)
 * will pick the rows up and really send them.
 *
 * An email can be LINKED to what it is about (entityType + entityId, for example
 * "student_application" + the application's id). That is how an admin sees, on
 * the application, whether its emails arrived - and can retry the failed ones.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import type { DbClient } from '../types/db-client';

export interface OutboxEmail {
  toEmail: string;
  /** Which template to use, e.g. "password-reset". */
  template: string;
  /** Values for the template, e.g. { fullName, actionUrl }. */
  payload: Prisma.InputJsonObject;
  /** Optional link to what the email is about, e.g. "student_application". */
  entityType?: string;
  /** ...and that thing's id. */
  entityId?: string;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async enqueue(email: OutboxEmail, db: DbClient = this.prisma): Promise<void> {
    await db.emailOutbox.create({
      data: {
        toEmail: email.toEmail,
        template: email.template,
        payload: email.payload,
        entityType: email.entityType ?? null,
        entityId: email.entityId ?? null,
      },
    });
  }

  /**
   * Puts the FAILED emails of one thing back in the queue with a fresh set of
   * attempts. Safe to press twice: emails that are pending or already sent are
   * never touched, so nothing is ever sent twice by this. Returns how many were re-queued.
   */
  async retryFailed(entityType: string, entityId: string, db: DbClient = this.prisma): Promise<number> {
    const result = await db.emailOutbox.updateMany({
      where: { entityType, entityId, status: EmailStatus.FAILED },
      data: { status: EmailStatus.PENDING, attempts: 0, lastError: null, nextAttemptAt: new Date() },
    });
    return result.count;
  }

  /**
   * DEVELOPMENT ONLY: since real email sending does not exist yet, print the
   * email's link in the terminal so you can click it while testing.
   * Does nothing in production or test mode, so links never reach real logs.
   */
  previewInDevelopment(email: OutboxEmail): void {
    if (this.config.get('NODE_ENV', { infer: true }) !== 'development') return;

    this.logger.warn(
      `\n  [DEV EMAIL PREVIEW] template="${email.template}" to=${email.toEmail}\n  link: ${String(
        email.payload.actionUrl ?? '(none)',
      )}\n`,
    );
  }
}