/**
 * student-age.spec.ts - the age rule behind "under 18 needs a guardian" and
 * the signup settings that the rest of the batch relies on.
 */
import { ageOnDate } from '../src/students/age';
import {
  ADULT_AGE,
  CONSENT_VERSION,
  MAX_PLAUSIBLE_AGE,
  SIGNUP_ROUTE_LIMIT,
} from '../src/students/students.constants';

describe('ageOnDate', () => {
  it('counts the birthday on the day itself', () => {
    expect(ageOnDate('2008-10-24', '2026-10-24')).toBe(18);
  });

  it('is still one year younger the day before the birthday', () => {
    expect(ageOnDate('2008-10-24', '2026-10-23')).toBe(17);
  });

  it('stays the same the day after the birthday', () => {
    expect(ageOnDate('2008-10-24', '2026-10-25')).toBe(18);
  });

  it('is one year younger when the birth month has not come yet', () => {
    expect(ageOnDate('2008-11-01', '2026-10-24')).toBe(17);
  });

  it('has had the birthday once the birth month has passed, whatever the day', () => {
    expect(ageOnDate('2008-09-30', '2026-10-01')).toBe(18);
  });

  it('handles the year boundary', () => {
    expect(ageOnDate('2000-12-31', '2026-01-01')).toBe(25);
    expect(ageOnDate('2000-12-31', '2026-12-31')).toBe(26);
  });

  it('gives 0 on the day of birth', () => {
    expect(ageOnDate('2026-10-24', '2026-10-24')).toBe(0);
  });

  it('treats a 29 February birthday as not yet reached on 28 February of a normal year', () => {
    expect(ageOnDate('2008-02-29', '2026-02-28')).toBe(17);
  });

  it('treats a 29 February birthday as reached on 1 March of a normal year', () => {
    expect(ageOnDate('2008-02-29', '2026-03-01')).toBe(18);
  });

  it('counts a 29 February birthday on 29 February of a leap year', () => {
    expect(ageOnDate('2008-02-29', '2028-02-29')).toBe(20);
  });

  it('works for the oldest date the database allows', () => {
    expect(ageOnDate('1900-01-01', '2026-10-24')).toBe(126);
  });
});

describe('the under-18 boundary', () => {
  const needsGuardian = (dateOfBirth: string, today: string) => ageOnDate(dateOfBirth, today) < ADULT_AGE;

  it('needs a guardian the day before her 18th birthday', () => {
    expect(needsGuardian('2008-10-24', '2026-10-23')).toBe(true);
  });

  it('does not need a guardian on her 18th birthday', () => {
    expect(needsGuardian('2008-10-24', '2026-10-24')).toBe(false);
  });
});

describe('signup settings', () => {
  it('treats 18 as adult', () => {
    expect(ADULT_AGE).toBe(18);
  });

  it('flags an implausibly old date of birth after 100 years', () => {
    expect(MAX_PLAUSIBLE_AGE).toBe(100);
  });

  it('records which wording of the terms was agreed (v1)', () => {
    expect(CONSENT_VERSION).toBe('v1');
  });

  it('limits signup to 10 requests per IP per 10 minutes', () => {
    expect(SIGNUP_ROUTE_LIMIT).toEqual({ limit: 10, ttl: 10 * 60 * 1000 });
  });
});
