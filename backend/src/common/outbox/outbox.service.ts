/**
 * outbox.service.ts
 * ---------------------------------------------------------------------------
 * Queues emails in the database ("outbox") instead of sending them directly.
 *
 * Why: the email row is written in the SAME transaction as the action that
 * causes it. So an email can never be lost if the server crashes, and is never
 * sent for something that was rolled back. A background worker (a later batch)
 * will pick the rows up and really send them.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
      },
    });
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