/**
 * students.constants.ts
 * ---------------------------------------------------------------------------
 * Tunable numbers and wording for student signup and the student dashboard,
 * in ONE place.
 */
const MINUTE = 60 * 1000;

/** Under this age a student needs a parent/guardian's details and consent. */
export const ADULT_AGE = 18;
/** An implausibly old date of birth is almost certainly a typing mistake. */
export const MAX_PLAUSIBLE_AGE = 100;

/**
 * The version label of the terms/privacy wording a student agreed to. It is
 * saved with every application as evidence of WHAT was agreed. When Girls Set
 * Go supplies new wording, change this label (e.g. 'v2').
 */
export const CONSENT_VERSION = 'v1';

/**
 * Signup limit per IP address: 10 per 10 minutes.
 * Deliberately more generous than login: a school computer lab (many girls,
 * one shared IP) must still work. Bots are stopped mainly by the hidden trap
 * field and validation; a CAPTCHA can be added when the frontend exists.
 */
export const SIGNUP_ROUTE_LIMIT = { limit: 10, ttl: 10 * MINUTE };

// --- Messages -------------------------------------------------------------
export const DUPLICATE_EMAIL_MESSAGE = 'That email already has an account. Sign in, or reset your password.';
export const PASSWORDS_DIFFER_MESSAGE = 'The two passwords do not match.';
export const UNKNOWN_TRACK_MESSAGE = 'Please choose one of the available tracks.';
export const GUARDIAN_REQUIRED_MESSAGE =
  "A parent or guardian's name, email and phone number are required for applicants under 18.";
export const GUARDIAN_CONSENT_REQUIRED_MESSAGE =
  'A parent or guardian must agree to the application for applicants under 18.';
export const GUARDIAN_PARTIAL_MESSAGE = 'Please give all three guardian details (name, email, phone), or none.';

/** What the dashboard tells the student in each situation. */
export const DASHBOARD_MESSAGES = {
  pending: 'Your application is being reviewed. Your course unlocks once you are accepted.',
  declined: 'Thank you for applying. We are unable to offer you a place at this time.',
  accepted: 'Welcome! Your course is unlocked.',
  none: 'We could not find an application for your account.',
} as const;