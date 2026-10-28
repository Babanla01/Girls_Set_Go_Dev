/**
 * env.validation.ts
 * ---------------------------------------------------------------------------
 * Checks every environment variable when the app starts.
 *
 * Plain-English purpose: if a setting is missing or malformed (for example no
 * database address), the app REFUSES to start and tells you exactly what is
 * wrong. That is far better than a confusing crash hours later.
 *
 * Uses "zod", a small library that describes what valid data looks like.
 */
import { z } from 'zod';

/** Turns "a, b ,c" into ["a","b","c"]; empty text becomes an empty list. */
const commaList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

/** Optional text: leaving it blank in ".env" counts as "not set". */
const optionalText = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // z.coerce.number turns the text "4000" from the environment into the number 4000.
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  APP_URL: z.string().url(),

  CORS_ORIGINS: commaList,

  DATABASE_URL: z
    .string()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'must start with postgresql://',
    }),

  REDIS_URL: z
    .string()
    .refine((value) => /^rediss?:\/\//.test(value), {
      message: 'must start with redis:// or rediss://',
    }),

  // 32+ characters so the signing key cannot be guessed by brute force.
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters long'),

  // Feature switch: lets people apply to become instructors through a public
  // form. OFF by default. Accounts are still always created by an admin.
  INSTRUCTOR_APPLICATIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),

  // --- Real email sending (all optional: with no SMTP_HOST, emails just stay in
  // the outbox and, in development, their links are printed in the terminal). ---
  SMTP_HOST: optionalText,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  // "true" for providers that use a secure connection from the start (usually port 465).
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: optionalText,
  SMTP_PASSWORD: optionalText,
  // The "From" of every email, e.g.  Girls Set Go <no-reply@yourdomain.org>
  MAIL_FROM: optionalText,
});

/** The validated, correctly-typed settings object used across the app. */
export type Env = z.infer<typeof envSchema>;

/**
 * Called once by the config module at startup.
 * Returns clean settings, or throws one readable error listing every problem.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  // Extra production safety: never run production with an obviously unsafe secret.
  if (
    result.data.NODE_ENV === 'production' &&
    result.data.SESSION_SECRET.toLowerCase().includes('replace-me')
  ) {
    throw new Error(
      'Invalid environment configuration:\n  - SESSION_SECRET: still contains the example placeholder',
    );
  }

  // Mail settings must be complete, or the email sender would fail later in a confusing way.
  const { SMTP_HOST, MAIL_FROM, SMTP_USER, SMTP_PASSWORD } = result.data;
  if (SMTP_HOST && !MAIL_FROM) {
    throw new Error('Invalid environment configuration:\n  - MAIL_FROM: required when SMTP_HOST is set');
  }
  if (Boolean(SMTP_USER) !== Boolean(SMTP_PASSWORD)) {
    throw new Error(
      'Invalid environment configuration:\n  - SMTP_USER and SMTP_PASSWORD: give both, or neither',
    );
  }

  return result.data;
}