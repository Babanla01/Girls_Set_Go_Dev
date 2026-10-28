/**
 * send-emails.ts
 * ---------------------------------------------------------------------------
 * Command-line tool that delivers the emails waiting in the outbox.
 *
 *   npm run email:send                keep running, checking for new emails
 *   npm run email:send -- --once      send what is waiting, then stop
 *
 * Before using it, fill in the mail settings in ".env" (SMTP_HOST, MAIL_FROM,
 * and usually SMTP_USER / SMTP_PASSWORD). On the server, keep it running as a
 * service next to the API (Docker, systemd or pm2), so it restarts if it stops.
 *
 * Press Ctrl+C to stop it: it finishes the email it is sending first.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

const IDLE_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  let app: INestApplicationContext | undefined;
  let stopping = false;

  const stop = () => {
    if (!stopping) console.log('\nStopping after the current email...');
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    // Loaded only now, so setup errors are reported as one friendly message.
    const { AppModule } = await import('../app.module');
    const { EmailSenderService, EMAIL_BATCH_SIZE } = await import('../common/email/email-sender.service');
    const { MailTransport } = await import('../common/email/mail.transport');

    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

    const transport = app.get(MailTransport);
    if (!transport.isConfigured()) {
      console.error('\nEmail sending is not set up. Add SMTP_HOST and MAIL_FROM (and usually SMTP_USER and SMTP_PASSWORD) to your ".env".\n');
      process.exitCode = 1;
      return;
    }

    const sender = app.get(EmailSenderService);
    console.log(once ? '\nSending waiting emails...' : '\nEmail sender running. Press Ctrl+C to stop.');

    do {
      const result = await sender.processBatch();
      if (result.claimed > 0) {
        console.log(
          `${new Date().toISOString()}  sent ${result.sent}, will retry ${result.retrying}, failed ${result.failed}`,
        );
      }
      if (once) break;
      // A full batch means more may be waiting: go straight on. Otherwise rest a little.
      if (result.claimed < EMAIL_BATCH_SIZE && !stopping) await sleep(IDLE_WAIT_MS);
    } while (!stopping);

    transport.close();
    console.log('Done.\n');
  } catch (error) {
    console.error(`\nThe email sender failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}

void main();