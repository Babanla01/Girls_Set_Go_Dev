/**
 * zoned-time.ts
 * ---------------------------------------------------------------------------
 * Working with a wall-clock time in a named timezone (the programme's zone is
 * America/Chicago), correctly across daylight saving changes.
 *
 * Plain-English rule used everywhere: a moment in time is STORED as an exact
 * instant (UTC). When a rule is about "5:00 PM on a calendar day in Chicago", it is
 * worked out here, so "5 PM" stays 5 PM Chicago time in winter and in summer.
 *
 *   zonedDateTimeToUtc('2026-10-09', '17:00', zone)  ->  the instant it is 5 PM that day in that zone
 *   localParts(instant, zone)                        ->  { date: '2026-10-09', time: '17:00' } in that zone
 *   addDaysToLocalDate('2026-10-09', 7)              ->  '2026-10-16'  (calendar days, no clock involved)
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let existing = formatters.get(zone);
  if (!existing) {
    existing = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, existing);
  }
  return existing;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsOf(instant: Date, zone: string): Parts {
  const found = formatter(zone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(found.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

/** How far ahead of UTC the zone's wall clock is at this instant (negative for Chicago), in milliseconds. */
function offsetMs(instant: Date, zone: string): number {
  const p = partsOf(instant, zone);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The exact instant at which the wall clock in `zone` shows this date and time ("YYYY-MM-DD", "HH:mm"). */
export function zonedDateTimeToUtc(date: string, time: string, zone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);

  // Take the zone's offset near that moment, then check it again at the result:
  // the two differ only when a daylight saving change falls in between.
  const first = offsetMs(new Date(wallClockAsUtc), zone);
  let result = wallClockAsUtc - first;
  const second = offsetMs(new Date(result), zone);
  if (second !== first) result = wallClockAsUtc - second;
  return new Date(result);
}

/** The calendar date and the clock time an instant has in the zone. */
export function localParts(instant: Date, zone: string): { date: string; time: string } {
  const p = partsOf(instant, zone);
  const two = (n: number) => String(n).padStart(2, '0');
  return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, time: `${two(p.hour)}:${two(p.minute)}` };
}

/** Adds (or subtracts) whole calendar days to "YYYY-MM-DD". */
export function addDaysToLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
