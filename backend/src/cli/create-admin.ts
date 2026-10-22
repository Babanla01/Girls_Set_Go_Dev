/**
 * create-admin.ts
 * ---------------------------------------------------------------------------
 * Command-line tool that creates an admin account and prints a one-time link
 * for choosing the password.
 *
 *   npm run admin:create -- --email admin@example.org --name "Ada Admin"
 *
 * Run it on the server (or your own machine against your own database). There
 * is deliberately NO website route that can do this.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const email = readOption('email');
  const name = readOption('name');

  if (!email || !name) {
    console.error('Usage: npm run admin:create -- --email admin@example.org --name "Full Name"');
    process.exitCode = 1;
    return;
  }

  let app: INestApplicationContext | undefined;

  try {
    // Loaded only now, so the usage message above works even when the
    // environment (.env) is not configured yet, and setup errors below are
    // reported as one friendly message instead of a stack trace.
    const { AppModule } = await import('../app.module');
    const { AdminBootstrapService } = await import('../auth/admin-bootstrap.service');

    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    const { link } = await app.get(AdminBootstrapService).createAdminInvite({ email, fullName: name });

    console.log('\nAdmin account created (waiting for a password).');
    console.log('Open this one-time link to choose the password (valid for 7 days, works once):\n');
    console.log(`  ${link}\n`);
  } catch (error) {
    console.error(`\nCould not create the admin: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}

void main();