/**
 * normalize-email.ts
 * ---------------------------------------------------------------------------
 * The ONE way the app cleans an email address before saving or comparing it:
 * remove stray spaces and lowercase it.
 *
 * Why: the database refuses mixed-case emails (a safety net), so every piece
 * of code that saves or looks up an email must use this first. That way
 * "Ada@Example.com " and "ada@example.com" are always the same person.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}