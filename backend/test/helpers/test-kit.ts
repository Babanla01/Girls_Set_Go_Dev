/**
 * test-kit.ts
 * ---------------------------------------------------------------------------
 * Shared set-up for integration tests that need the real app: starts it
 * against the TEST database and TEST Redis, and offers small helpers
 * (create a user, sign in as someone, read the latest emailed link...).
 *
 * Import it from a test file; it sets the safe test environment itself.
 */
import './integration-env'; // must stay first: sets the environment

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountStatus, Role } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import type { Portal } from '../../src/auth/auth.constants';
import { PasswordService } from '../../src/auth/password/password.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';

export const GOOD_PASSWORD = 'Sunny-Garden-42!';
export type TestAgent = ReturnType<typeof request.agent>;

const TABLES =
  'users, sessions, auth_tokens, audit_logs, instructor_applications, email_outbox, tracks, courses, cohorts, cohort_instructors';

export async function createTestKit() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  configureApp(app); // same global rules as the real server
  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);
  const goodHash = await app.get(PasswordService).hash(GOOD_PASSWORD); // hashed once, reused
  const server = () => app.getHttpServer();

  return {
    app,
    prisma,
    redis,
    goodHash,
    server,

    /** A browser-like client that remembers cookies. */
    agent: (): TestAgent => request.agent(server()),

    /** Empties every table and the test Redis database (number 15). */
    async reset(): Promise<void> {
      await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
      await redis.client.flushdb();
    },

    /** Creates a user directly in the database. Everyone gets GOOD_PASSWORD unless told otherwise. */
    createUser(
      overrides: Partial<{ email: string; fullName: string; role: Role; status: AccountStatus; withPassword: boolean }> = {},
    ) {
      return prisma.user.create({
        data: {
          email: overrides.email ?? 'student@example.org',
          fullName: overrides.fullName ?? 'Test Person',
          role: overrides.role ?? Role.STUDENT,
          status: overrides.status ?? AccountStatus.ACTIVE,
          passwordHash: overrides.withPassword === false ? null : goodHash,
        },
      });
    },

    /** Signs in through the real login route and returns the signed-in client. */
    async loginAgent(email: string, portal: Portal): Promise<TestAgent> {
      const client = request.agent(server());
      await client.post('/api/v1/auth/login').send({ email, password: GOOD_PASSWORD, portal }).expect(200);
      return client;
    },

    /** The secret from the most recent emailed link of a given template. */
    async latestEmailToken(template: string): Promise<string> {
      const row = await prisma.emailOutbox.findFirstOrThrow({ where: { template }, orderBy: { createdAt: 'desc' } });
      return new URL((row.payload as { actionUrl: string }).actionUrl).searchParams.get('token') as string;
    },

    async close(): Promise<void> {
      await app.close();
    },
  };
}

export type TestKit = Awaited<ReturnType<typeof createTestKit>>;