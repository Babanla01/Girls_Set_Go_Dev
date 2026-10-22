/**
 * seed.ts
 * ---------------------------------------------------------------------------
 * Command-line tool that creates the starter tracks (AI & Robotics, UI/UX
 * Design). Safe to run repeatedly.
 *
 *   npm run db:seed
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

async function main(): Promise<void> {
  let app: INestApplicationContext | undefined;

  try {
    // Loaded only now, so a missing/invalid .env is reported as one friendly message.
    const { AppModule } = await import('../app.module');
    const { AuditService } = await import('../common/audit/audit.service');
    const { PrismaService } = await import('../prisma/prisma.service');
    const { seedTracks } = await import('../catalog/seed-tracks');

    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    const { created, existing } = await seedTracks(app.get(PrismaService), app.get(AuditService));

    console.log('\nStarter tracks:');
    for (const name of created) console.log(`  + created   ${name}`);
    for (const name of existing) console.log(`  = already there  ${name}`);
    console.log('');
  } catch (error) {
    console.error(`\nCould not seed the tracks: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}

void main();