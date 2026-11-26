/**
 * dashboard-rules.ts
 * ---------------------------------------------------------------------------
 * The small decisions behind the student's learning dashboard, as pure functions (no database):
 *   - how many weeks are really COMPLETED (lessons done AND the assignment reviewed);
 *   - which week is "this week";
 *   - which assignment to show as "your next assignment";
 *   - the live classes: the one held last, the next one, and when its JOIN LINK may be shown;
 *   - the "journey" summary for a student who finished the course.
 */
import type { Snapshot } from '../course-content/snapshot';
import type { WeekProgress } from './learning-rules';

/** The join link appears this many minutes before a class starts. */
export const JOIN_OPENS_MINUTES_BEFORE = 10;

const MINUTE_MS = 60_000;

/**
 * Weeks completed = every lesson done AND the week's assignment reviewed (a week with no
 * assignment needs only its lessons). An empty week (no lessons, no assignment) never counts.
 */
export function weeksCompleted(snapshot: Snapshot, weeks: readonly WeekProgress[], graded: ReadonlySet<string>): number {
  return weeks.filter(
    (week, index) =>
      week.status === 'COMPLETE' && graded.has(week.id) && (week.lessonsTotal > 0 || snapshot.weeks[index].assignment !== null),
  ).length;
}

export interface ThisWeek {
  id: string;
  position: number;
  title: string;
  lessonsDone: number;
  lessonsTotal: number;
  status: WeekProgress['status'];
}

/** The first week still in progress; if none is, the last week that is open; null when nothing is open. */
export function thisWeek(weeks: readonly WeekProgress[]): ThisWeek | null {
  const week = weeks.find((candidate) => candidate.status === 'IN_PROGRESS') ?? [...weeks].reverse().find((candidate) => candidate.open) ?? null;
  return week
    ? { id: week.id, position: week.position, title: week.title, lessonsDone: week.lessonsDone, lessonsTotal: week.lessonsTotal, status: week.status }
    : null;
}

/** What the dashboard needs to know about one submission. */
export interface SubmissionLike {
  status: 'SUBMITTED' | 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';
  versionCount: number;
  review: { reviewedAt: Date } | null;
}

export interface NextAssignment {
  weekIndex: number;
  status: 'NOT_SUBMITTED' | 'NEEDS_REVISION';
}

/**
 * The first assignment (in course order, in a week that is open) that still needs her: not sent
 * yet, or sent back for changes. Assignments she has sent and that wait for review do not count.
 */
export function nextAssignment(
  snapshot: Snapshot,
  weeks: readonly WeekProgress[],
  submissions: ReadonlyMap<string, SubmissionLike>,
): NextAssignment | null {
  for (let index = 0; index < snapshot.weeks.length; index++) {
    const assignment = snapshot.weeks[index].assignment;
    if (!weeks[index]?.open || !assignment) continue;

    const submission = submissions.get(assignment.id);
    if (!submission) return { weekIndex: index, status: 'NOT_SUBMITTED' };
    if (submission.status === 'NEEDS_REVISION') return { weekIndex: index, status: 'NEEDS_REVISION' };
  }
  return null;
}

export interface JoinWindow {
  opensAt: Date;
  endsAt: Date;
  joinable: boolean;
}

/** The join link may be shown from 10 minutes before the start until the class ends. */
export function joinWindow(startsAt: Date, durationMinutes: number, now: Date): JoinWindow {
  const opensAt = new Date(startsAt.getTime() - JOIN_OPENS_MINUTES_BEFORE * MINUTE_MS);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * MINUTE_MS);
  return { opensAt, endsAt, joinable: now.getTime() >= opensAt.getTime() && now.getTime() < endsAt.getTime() };
}

export interface NextClass {
  weekPosition: number;
  weekTitle: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  notes: string | null;
  joinable: boolean;
  joinOpensAt: Date;
  /** Present ONLY while the join window is open (10 minutes before until the end); otherwise null. */
  joinUrl: string | null;
}

export interface LastClass {
  weekPosition: number;
  weekTitle: string;
  startsAt: Date;
  durationMinutes: number;
}

/** The next class that has not finished yet, and the most recent one that has. */
export function liveClasses(snapshot: Snapshot, now: Date): { next: NextClass | null; last: LastClass | null } {
  const classes = snapshot.weeks.flatMap((week, index) =>
    week.classSession
      ? [{ week, position: index + 1, session: week.classSession, startsAt: new Date(week.classSession.startsAt) }]
      : [],
  );
  classes.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const ends = (item: (typeof classes)[number]) => item.startsAt.getTime() + item.session.durationMinutes * MINUTE_MS;
  const upcoming = classes.find((item) => ends(item) > now.getTime()) ?? null;
  const held = [...classes].reverse().find((item) => ends(item) <= now.getTime()) ?? null;

  let next: NextClass | null = null;
  if (upcoming) {
    const window = joinWindow(upcoming.startsAt, upcoming.session.durationMinutes, now);
    next = {
      weekPosition: upcoming.position,
      weekTitle: upcoming.week.title,
      startsAt: upcoming.startsAt,
      endsAt: window.endsAt,
      durationMinutes: upcoming.session.durationMinutes,
      notes: upcoming.session.notes,
      joinable: window.joinable,
      joinOpensAt: window.opensAt,
      joinUrl: window.joinable ? upcoming.session.joinUrl : null,
    };
  }

  const last: LastClass | null = held
    ? { weekPosition: held.position, weekTitle: held.week.title, startsAt: held.startsAt, durationMinutes: held.session.durationMinutes }
    : null;
  return { next, last };
}

export interface Journey {
  lessonsDone: number;
  lessonsTotal: number;
  assignmentsTotal: number;
  assignmentsCompleted: number;
  assignmentsRevised: number;
  capstone: { title: string; reviewedAt: Date | null } | null;
}

/** "Your journey" for a student who finished the course. The capstone is the LAST week's assignment. */
export function journey(
  snapshot: Snapshot,
  lessonsDone: number,
  lessonsTotal: number,
  submissions: ReadonlyMap<string, SubmissionLike>,
): Journey {
  const assignments = snapshot.weeks.flatMap((week) => (week.assignment ? [week.assignment] : []));
  const lastWeek = snapshot.weeks[snapshot.weeks.length - 1];
  const capstone = lastWeek?.assignment ?? null;

  return {
    lessonsDone,
    lessonsTotal,
    assignmentsTotal: assignments.length,
    assignmentsCompleted: assignments.filter((assignment) => submissions.get(assignment.id)?.status === 'COMPLETED').length,
    assignmentsRevised: assignments.filter((assignment) => (submissions.get(assignment.id)?.versionCount ?? 0) > 1).length,
    capstone: capstone ? { title: capstone.title, reviewedAt: submissions.get(capstone.id)?.review?.reviewedAt ?? null } : null,
  };
}
