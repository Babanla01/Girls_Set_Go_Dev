/**
 * retention.constants.ts
 * ---------------------------------------------------------------------------
 * Settings and messages for the "remove declined applicants' personal data"
 * rule.
 *
 * The rule: two months after an application was DECLINED, the applicant's
 * personal details are removed. What stays: the fact that an application was
 * made and declined (and when), and the audit trail - none of which holds
 * personal details.
 *
 * How a removed account is recognised: its email address is replaced by a
 * reserved, never-deliverable one ("removed-<id>@removed.invalid"). The
 * ".invalid" ending is reserved by internet standards, so it can never be a
 * real person's address. Keeping this one rule in one place means every part
 * of the app recognises a removed account the same way.
 */

/** Declined applications older than this many months are due for removal. */
export const RETENTION_MONTHS = 2;

/** How many applicants one run handles at a time. */
export const RETENTION_BATCH_SIZE = 100;

export const REMOVED_ACCOUNT_EMAIL_DOMAIN = 'removed.invalid';
export const REMOVED_ACCOUNT_NAME = 'Removed applicant';
/** Written over the application answers (those columns cannot be empty). */
export const REMOVED_TEXT = '[removed]';

export const removedAccountEmail = (userId: string): string => `removed-${userId}@${REMOVED_ACCOUNT_EMAIL_DOMAIN}`;

export const isRemovedAccountEmail = (email: string): boolean => email.endsWith(`@${REMOVED_ACCOUNT_EMAIL_DOMAIN}`);

export const REMOVED_ACCOUNT_MESSAGE =
  "This applicant's personal data has been removed, so the account can no longer be changed.";
export const REMOVED_REOPEN_MESSAGE =
  "This application cannot be reopened because the applicant's personal data has been removed.";

/** The date this many calendar months before `date` (in UTC). */
export function monthsBefore(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() - months);
  return result;
}