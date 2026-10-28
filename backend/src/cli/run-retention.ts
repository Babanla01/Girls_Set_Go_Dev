/**
 * run-retention.ts
 * ---------------------------------------------------------------------------
 * Command-line tool that removes the personal details of applicants whose
 * application was declined more than two months ago.
 *
 *   npm run retention:run                 do it
 *   npm run retention:run -- --dry-run    only count who is due; change nothing
 *
 * Run it on the server once a night. Example (every day at 03:00):
 *
 *   0 3 * * *  cd /path/to/backend && npm run retention:run >> retention.log 2>&1
 *
 * Safe to run more often: applicants already processed are never touched again.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  let app: INestApplicationContext | undefined;

  try {
    // Loaded only now, so setup errors are reported as one friendly message.
    const { AppModule } = await import('../app.module');
    const { RetentionService } = await import('../retention/retention.service');

    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    const retention = app.get(RetentionService);

    if (dryRun) {
      const due = await retention.countDue();
      console.log(`\nDry run: ${due} declined applicant(s) are due for removal. Nothing was changed.\n`);
      return;
    }

    const { removed, skipped, failed } = await retention.removeDue();
    console.log(
      `\nDone: personal data removed for ${removed} applicant(s); ${skipped} skipped; ${failed} failed.\n`,
    );
    if (failed > 0) {
      console.error('Some applicants could not be processed (see the messages above). They will be retried next run.\n');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`\nThe retention run failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}

void main();