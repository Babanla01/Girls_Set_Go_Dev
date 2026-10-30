/**
 * course-content.constants.ts
 * ---------------------------------------------------------------------------
 * Every size limit and shared name for course content, in ONE place with plain
 * names. To change a limit, change it here and nowhere else.
 */

/** The permission rule ("may this person open / edit this course content?"). */
export const COURSE_CONTENT_MANAGE = 'course-content.manage';

export const LIMITS = {
  // --- how big a course may get
  weeks: 52,
  lessonsPerWeek: 40,
  blocksPerLesson: 60,

  // --- text sizes (characters)
  title: 150,
  summary: 1_000,
  textBody: 20_000,
  instructions: 10_000,
  transcript: 50_000,
  calloutBody: 2_000,
  stepTitle: 150,
  stepDetail: 2_000,
  steps: 30,
  description: 500,
  url: 2_000,

  /** Longest a lesson, activity or video may be (minutes). */
  minutes: 600,
} as const;
