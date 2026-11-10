/**
 * submission.constants.ts
 * ---------------------------------------------------------------------------
 * The limits of a student's submission, in ONE place.
 */

/** A submission has at most this many files. */
export const MAX_SUBMISSION_FILES = 5;

/** A student can send at most this many versions of one assignment. */
export const MAX_SUBMISSION_VERSIONS = 25;

/** The longest written note. */
export const MAX_NOTE_LENGTH = 2_000;

/** After an instructor asks for changes, the student may resubmit for this many days. */
export const REVISION_WINDOW_DAYS = 7;
