/**
 * test-database-url.ts
 * ---------------------------------------------------------------------------
 * Works out which database the automated database tests use, and REFUSES to
 * continue unless its name ends in "_test".
 *
 * Why the guard matters: these tests empty the tables before each test. The
 * check makes it impossible to point them at your real development database
 * by accident.
 */
import * as dotenv from 'dotenv';
import { resolve } from 'node:path';

export function getTestDatabaseUrl(): string {
  // Read backend/.env so the tests use the same settings as the app.
  dotenv.config({ path: resolve(__dirname, '../../.env'), quiet: true });

  let url = process.env.TEST_DATABASE_URL;

  // If no explicit test URL is set, derive one: ".../gsg_lms" -> ".../gsg_lms_test"
  if (!url && process.env.DATABASE_URL) {
    const derived = new URL(process.env.DATABASE_URL);
    derived.pathname = `${derived.pathname}_test`;
    url = derived.toString();
  }

  if (!url) {
    throw new Error(
      'No test database configured. Set TEST_DATABASE_URL in backend/.env (see .env.example).',
    );
  }

  const databaseName = new URL(url).pathname.replace('/', '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run: test database name must end in "_test" but got "${databaseName}".`,
    );
  }

  return url;
}