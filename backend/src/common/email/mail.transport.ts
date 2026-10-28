/**
 * mail.transport.ts
 * ---------------------------------------------------------------------------
 * The one place that talks to the outside mail server (SMTP). It works with
 * any provider that offers SMTP: your web host's mail, Resend, SendGrid,
 * Mailgun, Amazon SES, and so on - you only change the settings in ".env".
 *
 * Everything else asks THIS class to send, so tests can replace it and never
 * contact a real mail server.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

import type { Env } from '../../config/env.validation';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

@Injectable()
export class MailTransport {
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** True when the mail settings (SMTP_HOST and MAIL_FROM) have been filled in. */
  isConfigured(): boolean {
    return Boolean(this.config.get('SMTP_HOST', { infer: true }) && this.config.get('MAIL_FROM', { infer: true }));
  }

  /** Sends one email. Throws if the mail server refuses it. */
  async send(message: MailMessage): Promise<void> {
    const from = this.config.get('MAIL_FROM', { infer: true });
    if (!from) throw new Error('Email sending is not set up (MAIL_FROM is missing).');

    await this.client().sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }

  /** Closes the connection (used when the sender command shuts down). */
  close(): void {
    this.transporter?.close();
  }

  private client(): Transporter {
    if (this.transporter) return this.transporter;

    const host = this.config.get('SMTP_HOST', { infer: true });
    if (!host) throw new Error('Email sending is not set up (SMTP_HOST is missing).');

    const user = this.config.get('SMTP_USER', { infer: true });
    const pass = this.config.get('SMTP_PASSWORD', { infer: true });

    this.transporter = createTransport({
      host,
      port: this.config.get('SMTP_PORT', { infer: true }),
      secure: this.config.get('SMTP_SECURE', { infer: true }),
      auth: user && pass ? { user, pass } : undefined,
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
    });
    return this.transporter;
  }
}