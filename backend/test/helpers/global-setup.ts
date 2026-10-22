/**
 * global-setup.ts
 * ---------------------------------------------------------------------------
 * Runs ONCE before the database tests: applies every migration to the test
 * database. If a migration is broken, the tests stop here with a clear error.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

import { getTestDatabaseUrl } from './test-database-url';

export default async function globalSetup(): Promise<void> {
  const url = getTestDatabaseUrl();

  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '../..'),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}