/**
 * learning.constants.ts
 * ---------------------------------------------------------------------------
 * The wording and limits of the student's learning screens, in ONE place.
 * (The wording comes from the design guide.)
 */

/** Shown (403) to anyone who has no place in a cohort: pending, declined or never applied. No course details leak. */
export const NOT_OPEN_MESSAGE =
  "This course isn't open for you yet. Courses unlock after the Girls Set Go team accepts your application and places you in a track and cohort.";

/** Shown when her cohort has a course but nobody has published it yet. */
export const NOT_READY_MESSAGE = "Your course content isn't ready yet. Your instructor will publish it soon.";

/** Shown to a student who finished the course: she can read everything but cannot change progress. */
export const READ_ONLY_MESSAGE = 'You have completed this course, so it is read-only now.';

export const cohortNotStartedMessage = (startsOn: string): string =>
  `Your cohort starts on ${startsOn}. Your course will open then.`;

/** The longest video the position can point into (24 hours of seconds). */
export const MAX_VIDEO_SECONDS = 86_400;
