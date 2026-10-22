/**
 * catalog.util.spec.ts
 * ---------------------------------------------------------------------------
 * The pure helpers behind tracks, courses and cohorts: name cleaning, calendar
 * dates, "today" in the programme's timezone, and the upcoming/running/ended
 * calculation.
 */
import 'reflect-metadata'; // the decorators need this; the real app loads it at start-up
import { validate } from 'class-validator';

import {
  cleanLabel,
  COHORT_PHASES,
  cohortPhase,
  formatCalendarDate,
  isCalendarDate,
  labelKey,
  parseCalendarDate,
  todayInProgrammeZone,
} from '../src/catalog/catalog.util';
import { IsCalendarDate } from '../src/common/validation/calendar-date.decorator';

describe('names', () => {
  it('cleans spaces: trims the ends and squashes repeats', () => {
    expect(cleanLabel('  AI   &  Robotics ')).toBe('AI & Robotics');
  });

  it('makes a lowercase key so names differing only by capitals match', () => {
    expect(labelKey('  AI   &  ROBOTICS ')).toBe('ai & robotics');
    expect(labelKey('ai & robotics')).toBe(labelKey('AI & Robotics'));
  });
});

describe('calendar dates', () => {
  it('accepts real dates in YYYY-MM-DD form, including leap days', () => {
    expect(isCalendarDate('2026-11-03')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true); // 2028 is a leap year
  });

  it('rejects impossible dates and other formats', () => {
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-5', '03/11/2026', '2026-11-03T10:00:00Z', '', 'tomorrow']) {
      expect(isCalendarDate(bad)).toBe(false);
    }
  });

  it('converts to and from the stored form without drifting by a day', () => {
    expect(formatCalendarDate(parseCalendarDate('2026-11-03'))).toBe('2026-11-03');
    expect(parseCalendarDate('2026-11-03').toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  it('works as a validation rule on a field', async () => {
    class Sample {
      @IsCalendarDate()
      day!: unknown;
    }
    const check = async (day: unknown) => (await validate(Object.assign(new Sample(), { day }))).length;

    expect(await check('2026-11-03')).toBe(0);
    expect(await check('2026-02-30')).toBeGreaterThan(0);
    expect(await check(20261103)).toBeGreaterThan(0); // a number is not a date string
    expect(await check(undefined)).toBeGreaterThan(0);
  });
});

describe('today in the programme timezone', () => {
  it('uses the Lagos calendar day, not the server (UTC) day', () => {
    // 23:30 UTC on the 13th is already 00:30 on the 14th in Lagos (UTC+1).
    expect(todayInProgrammeZone(new Date('2026-10-13T23:30:00Z'), 'Africa/Lagos')).toBe('2026-10-14');
    expect(todayInProgrammeZone(new Date('2026-10-13T22:30:00Z'), 'Africa/Lagos')).toBe('2026-10-13');
  });

  it('follows whichever timezone it is given', () => {
    expect(todayInProgrammeZone(new Date('2026-10-13T23:30:00Z'), 'UTC')).toBe('2026-10-13');
    expect(todayInProgrammeZone(new Date('2026-10-13T23:30:00Z'), 'Pacific/Auckland')).toBe('2026-10-14');
  });

  it('defaults to the timezone in the branding file', () => {
    expect(todayInProgrammeZone(new Date('2026-10-13T23:30:00Z'))).toBe('2026-10-14');
  });
});

describe('cohort phase', () => {
  const starts = parseCalendarDate('2026-11-03');
  const ends = parseCalendarDate('2027-02-20');

  it('is upcoming before the first day', () => {
    expect(cohortPhase(starts, ends, '2026-11-02')).toBe('upcoming');
  });

  it('counts the first and the last day as running', () => {
    expect(cohortPhase(starts, ends, '2026-11-03')).toBe('running');
    expect(cohortPhase(starts, ends, '2027-01-01')).toBe('running');
    expect(cohortPhase(starts, ends, '2027-02-20')).toBe('running');
  });

  it('is ended after the last day', () => {
    expect(cohortPhase(starts, ends, '2027-02-21')).toBe('ended');
  });

  it('handles a one-day cohort', () => {
    const day = parseCalendarDate('2026-11-03');
    expect(cohortPhase(day, day, '2026-11-02')).toBe('upcoming');
    expect(cohortPhase(day, day, '2026-11-03')).toBe('running');
    expect(cohortPhase(day, day, '2026-11-04')).toBe('ended');
  });

  it('lists exactly the three phases', () => {
    expect([...COHORT_PHASES]).toEqual(['upcoming', 'running', 'ended']);
  });
});