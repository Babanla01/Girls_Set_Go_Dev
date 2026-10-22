/**
 * env.validation.spec.ts
 * ---------------------------------------------------------------------------
 * Proves the startup settings check does its job: good settings pass, and
 * missing or unsafe settings are rejected with a clear message.
 */
import { validateEnv } from '../src/config/env.validation';

const validEnv = {
  NODE_ENV: 'development',
  PORT: '4000',
  APP_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000, http://localhost:3001',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'a-test-secret-that-is-definitely-long-enough-123',
};

describe('validateEnv', () => {
  it('accepts valid settings and converts types', () => {
    const env = validateEnv(validEnv);
    expect(env.PORT).toBe(4000); // text became a number
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
    expect(env.LOG_LEVEL).toBe('info'); // default applied
  });

  it('keeps instructor applications OFF unless explicitly enabled', () => {
    expect(validateEnv(validEnv).INSTRUCTOR_APPLICATIONS_ENABLED).toBe(false);
    expect(
      validateEnv({ ...validEnv, INSTRUCTOR_APPLICATIONS_ENABLED: 'true' })
        .INSTRUCTOR_APPLICATIONS_ENABLED,
    ).toBe(true);
  });

  it('rejects an unclear value for the instructor applications switch', () => {
    expect(() => validateEnv({ ...validEnv, INSTRUCTOR_APPLICATIONS_ENABLED: 'yes' })).toThrow(
      /INSTRUCTOR_APPLICATIONS_ENABLED/,
    );
  });

  it('rejects a missing database address and names the problem', () => {
    const { DATABASE_URL, ...withoutDb } = validEnv;
    expect(() => validateEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('rejects a session secret that is too short', () => {
    expect(() => validateEnv({ ...validEnv, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('refuses the placeholder secret in production', () => {
    expect(() =>
      validateEnv({
        ...validEnv,
        NODE_ENV: 'production',
        SESSION_SECRET: 'replace-me-with-a-long-random-string-of-at-least-32-chars',
      }),
    ).toThrow(/placeholder/);
  });
});