/**
 * retention.constants.spec.ts - the small rules behind "remove declined
 * applicants' personal data after two months".
 */
import {
  isRemovedAccountEmail,
  monthsBefore,
  REMOVED_ACCOUNT_EMAIL_DOMAIN,
  removedAccountEmail,
  RETENTION_MONTHS,
} from '../src/retention/retention.constants';

describe('monthsBefore', () => {
  it('goes back whole calendar months', () => {
    expect(monthsBefore(new Date('2026-10-25T09:30:00Z'), 2).toISOString()).toBe('2026-08-25T09:30:00.000Z');
    expect(monthsBefore(new Date('2026-10-25T09:30:00Z'), 1).toISOString()).toBe('2026-09-25T09:30:00.000Z');
  });

  it('crosses the start of a year', () => {
    expect(monthsBefore(new Date('2026-01-15T00:00:00Z'), 2).toISOString()).toBe('2025-11-15T00:00:00.000Z');
    expect(monthsBefore(new Date('2026-02-10T00:00:00Z'), 2).toISOString()).toBe('2025-12-10T00:00:00.000Z');
  });

  it('does not change the date it was given', () => {
    const original = new Date('2026-10-25T09:30:00Z');
    monthsBefore(original, 2);
    expect(original.toISOString()).toBe('2026-10-25T09:30:00.000Z');
  });

  it('gives the same date for zero months', () => {
    expect(monthsBefore(new Date('2026-10-25T09:30:00Z'), 0).toISOString()).toBe('2026-10-25T09:30:00.000Z');
  });

  it('keeps data for two months (the rule agreed for this project)', () => {
    expect(RETENTION_MONTHS).toBe(2);
  });
});

describe('removed accounts', () => {
  const id = '3f2c1a9e-5b7d-4c6e-8a1f-0d9e2b4c6a8f';

  it('get a reserved address that can never belong to a real person', () => {
    expect(removedAccountEmail(id)).toBe(`removed-${id}@removed.invalid`);
    expect(REMOVED_ACCOUNT_EMAIL_DOMAIN).toBe('removed.invalid');
  });

  it('get an address the database accepts: lowercase and short enough', () => {
    const email = removedAccountEmail(id);
    expect(email).toBe(email.toLowerCase());
    expect(email.length).toBeLessThanOrEqual(254);
  });

  it('get a different address each, so many can exist at once', () => {
    expect(removedAccountEmail('a')).not.toBe(removedAccountEmail('b'));
  });

  it('are recognised by their address', () => {
    expect(isRemovedAccountEmail(removedAccountEmail(id))).toBe(true);
    expect(isRemovedAccountEmail('anyone@removed.invalid')).toBe(true);
  });

  it.each([
    'ada@example.org',
    'removed.invalid@example.org',
    'ada@notremoved.invalid',
    'ada@removed.invalid.org',
    'ada@sub.removed.invalid',
    '',
  ])('does not mistake "%s" for a removed account', (email) => {
    expect(isRemovedAccountEmail(email)).toBe(false);
  });
});