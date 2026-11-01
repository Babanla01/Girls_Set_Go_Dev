/**
 * learning-rules.ts
 * ---------------------------------------------------------------------------
 * The RULES of the student's course, as pure functions (no database), so they are
 * easy to read and to test on their own.
 *
 *   WEEKS OPEN ONE AT A TIME
 *     - Week 1 is open from the start.
 *     - A later week opens when the PREVIOUS week's lessons are all complete.
 *       (Batch 4 adds "and its assignment is graded" through `gradedWeeks`.)
 *     - A week an instructor opened early, and a week that has already been opened
 *       for her, stay open ("unlocked").
 *     - Inside an open week, lessons can be done in any order.
 *     - A student who completed the course sees every week open (read-only).
 *
 *   PROGRESS
 *     - lessons done / total lessons, as a whole-number percentage;
 *     - weeks completed = open weeks whose lessons are all done.
 *
 * Only lessons that exist in the published version count, so a lesson removed from
 * the live course simply stops counting.
 */
import type { Snapshot } from '../course-content/snapshot';

export type WeekStatus = 'LOCKED' | 'IN_PROGRESS' | 'COMPLETE';

export interface LockedReason {
  code: 'PREVIOUS_WEEK_INCOMPLETE';
  /** The sentence shown to the student (and returned with the 403 for a locked lesson). */
  message: string;
  previousWeek: { position: number; title: string };
  lessonsRemaining: number;
}

export interface LessonProgressView {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  estimatedMinutes: number | null;
  completed: boolean;
}

export interface WeekProgress {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  status: WeekStatus;
  open: boolean;
  lessonsDone: number;
  lessonsTotal: number;
  lockedReason: LockedReason | null;
  lessons: LessonProgressView[];
}

export interface EvaluateOptions {
  /** Ids of the lessons she completed. */
  completed: ReadonlySet<string>;
  /** Ids of the weeks already opened for her (by progress or early). */
  unlocked: ReadonlySet<string>;
  /** Every week counts as open (a student who finished the course). */
  allOpen?: boolean;
  /** Batch 4: weeks whose assignment has been graded. When given, it is required to open the next week. */
  gradedWeeks?: ReadonlySet<string>;
}

export const lockedMessage = (previousPosition: number): string =>
  `Opens after the Week ${previousPosition} lessons are complete.`;

/** Works out, for every week of the published course, whether it is open and how far she got. */
export function evaluateWeeks(snapshot: Snapshot, options: EvaluateOptions): WeekProgress[] {
  const weeks: WeekProgress[] = [];

  snapshot.weeks.forEach((week, index) => {
    const lessons: LessonProgressView[] = week.lessons.map((lesson, lessonIndex) => ({
      id: lesson.id,
      position: lessonIndex + 1,
      title: lesson.title,
      summary: lesson.summary,
      estimatedMinutes: lesson.estimatedMinutes,
      completed: options.completed.has(lesson.id),
    }));
    const lessonsDone = lessons.filter((lesson) => lesson.completed).length;
    const lessonsTotal = lessons.length;

    const previous = index > 0 ? weeks[index - 1] : null;
    const previousFinished =
      previous === null ||
      (previous.lessonsDone === previous.lessonsTotal && (!options.gradedWeeks || options.gradedWeeks.has(previous.id)));
    const open = options.allOpen === true || previousFinished || options.unlocked.has(week.id);

    weeks.push({
      id: week.id,
      position: index + 1,
      title: week.title,
      summary: week.summary,
      open,
      status: !open ? 'LOCKED' : lessonsDone === lessonsTotal ? 'COMPLETE' : 'IN_PROGRESS',
      lessonsDone,
      lessonsTotal,
      lockedReason:
        open || previous === null
          ? null
          : {
              code: 'PREVIOUS_WEEK_INCOMPLETE',
              message: lockedMessage(previous.position),
              previousWeek: { position: previous.position, title: previous.title },
              lessonsRemaining: previous.lessonsTotal - previous.lessonsDone,
            },
      lessons,
    });
  });

  return weeks;
}

export interface ProgressSummary {
  lessonsDone: number;
  lessonsTotal: number;
  /** Whole number, 0 to 100 (0 when the course has no lessons yet). */
  percent: number;
  weeksCompleted: number;
  weeksTotal: number;
}

export function summarizeProgress(weeks: readonly WeekProgress[]): ProgressSummary {
  const lessonsDone = weeks.reduce((total, week) => total + week.lessonsDone, 0);
  const lessonsTotal = weeks.reduce((total, week) => total + week.lessonsTotal, 0);
  return {
    lessonsDone,
    lessonsTotal,
    percent: lessonsTotal === 0 ? 0 : Math.round((lessonsDone * 100) / lessonsTotal),
    weeksCompleted: weeks.filter((week) => week.status === 'COMPLETE' && week.lessonsTotal > 0).length,
    weeksTotal: weeks.length,
  };
}

export interface LessonRef {
  id: string;
  title: string;
  weekId: string;
  weekPosition: number;
}

/** The lessons she can open right now, in course order. */
export function openLessons(weeks: readonly WeekProgress[]): (LessonRef & { completed: boolean })[] {
  return weeks
    .filter((week) => week.open)
    .flatMap((week) =>
      week.lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        weekId: week.id,
        weekPosition: week.position,
        completed: lesson.completed,
      })),
    );
}

/**
 * "Continue learning": the first lesson she has not completed. When `afterLessonId`
 * is given, it looks after that lesson first (and then from the start).
 */
export function findNextLesson(weeks: readonly WeekProgress[], afterLessonId?: string): LessonRef | null {
  const lessons = openLessons(weeks);
  const start = afterLessonId ? lessons.findIndex((lesson) => lesson.id === afterLessonId) + 1 : 0;

  const pending = (lesson: (typeof lessons)[number]) => !lesson.completed && lesson.id !== afterLessonId;
  const next = lessons.slice(start).find(pending) ?? lessons.slice(0, start).find(pending);
  return next ? { id: next.id, title: next.title, weekId: next.weekId, weekPosition: next.weekPosition } : null;
}

/** The lessons just before and after one lesson in course order (only lessons she can open). */
export function neighbours(weeks: readonly WeekProgress[], lessonId: string): { previous: LessonRef | null; next: LessonRef | null } {
  const lessons = openLessons(weeks);
  const index = lessons.findIndex((lesson) => lesson.id === lessonId);
  const ref = (lesson: (typeof lessons)[number] | undefined): LessonRef | null =>
    lesson ? { id: lesson.id, title: lesson.title, weekId: lesson.weekId, weekPosition: lesson.weekPosition } : null;
  return { previous: index > 0 ? ref(lessons[index - 1]) : null, next: index >= 0 ? ref(lessons[index + 1]) : null };
}

/** Finds a lesson (and its week) by id. */
export function locateLesson(weeks: readonly WeekProgress[], lessonId: string): { week: WeekProgress; lesson: LessonProgressView } | null {
  for (const week of weeks) {
    const lesson = week.lessons.find((candidate) => candidate.id === lessonId);
    if (lesson) return { week, lesson };
  }
  return null;
}
