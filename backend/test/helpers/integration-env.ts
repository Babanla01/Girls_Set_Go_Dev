/**
 * integration-env.ts
 * ---------------------------------------------------------------------------
 * IMPORT THIS FIRST in every integration test file (before the app code).
 * It sets the environment variables the app needs, pointing at the TEST
 * database and TEST Redis - never your development ones.
 *
 * Safety: the database name must end in "_test" (checked in
 * test-database-url.ts) and Redis always uses database number 15, which the
 * tests empty freely. Your normal Redis data (database 0) is never touched.
 */
import * as dotenv from 'dotenv';
import { resolve } from 'node:path';

import { getTestDatabaseUrl } from './test-database-url';

export const TEST_APP_ORIGIN = 'http://localhost:3000';

export function getTestRedisUrl(): string {
  dotenv.config({ path: resolve(__dirname, '../../.env'), quiet: true });

  const base = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  base.pathname = '/15'; // Redis database 15 = tests only
  return base.toString();
}

process.env.NODE_ENV = 'test';
process.env.APP_URL = TEST_APP_ORIGIN;
process.env.CORS_ORIGINS = TEST_APP_ORIGIN;
process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.REDIS_URL = getTestRedisUrl();
process.env.SESSION_SECRET = 'integration-test-secret-that-is-long-enough-0123456789';
process.env.INSTRUCTOR_APPLICATIONS_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';