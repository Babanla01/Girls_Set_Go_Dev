/**
 * env-mail.spec.ts - the email settings in ".env" are checked at startup.
 * Email sending is optional, but if it is set up it must be set up completely.
 */
import { validateEnv } from '../src/config/env.validation';

const validEnv = {
  NODE_ENV: 'development',
  PORT: '4000',
  APP_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'a-test-secret-that-is-definitely-long-enough-123',
};

const mail = {
  SMTP_HOST: 'smtp.example.org',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: 'apikey',
  SMTP_PASSWORD: 'secret-value',
  MAIL_FROM: 'Girls Set Go <no-reply@example.org>',
};

describe('validateEnv: email settings', () => {
  it('needs none of them: email sending is optional', () => {
    const env = validateEnv(validEnv);

    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.MAIL_FROM).toBeUndefined();
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.SMTP_PASSWORD).toBeUndefined();
    expect(env.SMTP_PORT).toBe(587); // default
    expect(env.SMTP_SECURE).toBe(false); // default
  });

  it('accepts a complete set and converts the types', () => {
    const env = validateEnv({ ...validEnv, ...mail });

    expect(env.SMTP_HOST).toBe('smtp.example.org');
    expect(env.SMTP_PORT).toBe(465); // text became a number
    expect(env.SMTP_SECURE).toBe(true); // text became a yes/no
    expect(env.SMTP_USER).toBe('apikey');
    expect(env.SMTP_PASSWORD).toBe('secret-value');
    expect(env.MAIL_FROM).toBe('Girls Set Go <no-reply@example.org>');
  });

  it('accepts a server that needs no login', () => {
    const env = validateEnv({ ...validEnv, SMTP_HOST: 'localhost', MAIL_FROM: 'no-reply@example.org' });
    expect(env.SMTP_USER).toBeUndefined();
  });

  it('treats blank values (as in the .env.example file) as "not set"', () => {
    const env = validateEnv({
      ...validEnv,
      SMTP_HOST: '',
      SMTP_USER: '   ',
      SMTP_PASSWORD: '',
      MAIL_FROM: '',
    });

    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.SMTP_PASSWORD).toBeUndefined();
    expect(env.MAIL_FROM).toBeUndefined();
  });

  it('trims spaces around values', () => {
    const env = validateEnv({ ...validEnv, ...mail, SMTP_HOST: '  smtp.example.org  ' });
    expect(env.SMTP_HOST).toBe('smtp.example.org');
  });

  it('refuses a mail server with no "From" address', () => {
    const { MAIL_FROM, ...withoutFrom } = mail;
    expect(() => validateEnv({ ...validEnv, ...withoutFrom })).toThrow(/MAIL_FROM/);
  });

  it('refuses a username without a password, and a password without a username', () => {
    const { SMTP_PASSWORD, ...onlyUser } = mail;
    const { SMTP_USER, ...onlyPassword } = mail;

    expect(() => validateEnv({ ...validEnv, ...onlyUser })).toThrow(/SMTP_USER and SMTP_PASSWORD/);
    expect(() => validateEnv({ ...validEnv, ...onlyPassword })).toThrow(/SMTP_USER and SMTP_PASSWORD/);
  });

  it('rejects an unclear value for the secure-connection switch', () => {
    expect(() => validateEnv({ ...validEnv, ...mail, SMTP_SECURE: 'yes' })).toThrow(/SMTP_SECURE/);
  });

  it.each(['0', '70000', 'abc', '-1', '25.5'])('rejects the port "%s"', (port) => {
    expect(() => validateEnv({ ...validEnv, ...mail, SMTP_PORT: port })).toThrow(/SMTP_PORT/);
  });

  it('never prints the password in an error message', () => {
    const { MAIL_FROM, ...withoutFrom } = mail;
    try {
      validateEnv({ ...validEnv, ...withoutFrom });
      throw new Error('should have failed');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-value');
    }
  });
});