/**
 * workspace.constants.ts
 * ---------------------------------------------------------------------------
 * The numbers and sentences of the instructor workspace, in ONE place.
 */
import { branding } from '../../config/branding.config';

/** A student who has been quiet this long is flagged "Needs attention". */
export const ATTENTION_AFTER_DAYS = 7;

/** ... and "Inactive" when she has been quiet this long. */
export const INACTIVE_AFTER_DAYS = 21;

/** A student who was asked for changes needs attention when her resubmit date is this close (or past). */
export const REVISION_DEADLINE_WARNING_DAYS = 2;

/** How many submissions the dashboard's review queue shows (the full list is the grading inbox). */
export const QUEUE_SIZE = 5;

/** How many activity lines a student's detail shows. */
export const RECENT_ACTIVITY = 8;

/** The most students one CSV export may contain. */
export const EXPORT_MAX_ROWS = 5000;

/** Shown (with a 403) when an instructor opens a student outside her cohorts. */
export const OUT_OF_SCOPE_MESSAGE =
  "This student isn't in your cohorts. You can only open students, lessons and submissions for the courses and cohorts you're assigned to. If you should have access, ask an admin to update your teaching scope.";

/** Instructors never message students directly (they are minors): they go through support. */
export const SUPPORT_MESSAGE =
  'Instructors do not message students directly. To reach a student or her family, write to support and they will help.';

export const SUPPORT_EMAIL = branding.supportEmail;
