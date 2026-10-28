/**
 * auth.constants.ts
 * ---------------------------------------------------------------------------
 * Every tunable number for authentication, in ONE place with plain names.
 * To change a policy (say, session length), change it here and nowhere else.
 */
import { Role } from '@prisma/client';

import { branding } from '../config/branding.config';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// --- Sessions ---------------------------------------------------------------
/** Signed out after this long without any activity. */
export const SESSION_IDLE_MS = 7 * DAY;
/** Signed out after this long no matter what ("30 days max"). */
export const SESSION_ABSOLUTE_MS = 30 * DAY;
/** We record "last active" at most this often, to avoid a database write on every click. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * MINUTE;

// --- One-time links ---------------------------------------------------------
/** An instructor's invite link works for 72 hours (3 days). */
export const INVITE_LINK_TTL_MS = 3 * DAY;
/** A password-reset link works for 30 minutes. */
export const RESET_LINK_TTL_MS = 30 * MINUTE;
/** Email verification links expire after 24 hours. */
export const VERIFY_LINK_TTL_MS = 1 * DAY;

// --- Guessing protection ------------------------------------------------------
/** After this many wrong passwords for one email... */
export const LOGIN_MAX_FAILURES = 5;
/** ...logins for that email pause for this many seconds (15 minutes). */
export const LOGIN_PAUSE_SECONDS = 15 * 60;

/** Per-IP limit for sensitive routes (login, reset, invite): 5 per minute. */
export const SENSITIVE_ROUTE_LIMIT = { limit: 5, ttl: MINUTE };

// --- Passwords ----------------------------------------------------------------
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// --- Cookies ------------------------------------------------------------------
/** "__Host-" makes browsers refuse the cookie unless it is secure and site-wide. */
export const SESSION_COOKIE_NAME = 'gsg_session';
export const SESSION_COOKIE_NAME_SECURE = '__Host-gsg_session';

// --- Login doors --------------------------------------------------------------
/** Which role each login page (door) is for. */
export const PORTAL_ROLES = {
  student: Role.STUDENT,
  instructor: Role.INSTRUCTOR,
  admin: Role.ADMIN,
} as const;

export type Portal = keyof typeof PORTAL_ROLES;
export const PORTALS = Object.keys(PORTAL_ROLES) as Portal[];

// --- Messages -------------------------------------------------------------------
/** ONE message for every kind of failed login, so nothing is revealed. */
export const GENERIC_LOGIN_ERROR = 'Email or password is incorrect.';
/**
 * Shown ONLY after the correct password was typed for a suspended account
 * (someone who does not know the password never learns the account exists).
 */
export const ACCOUNT_PAUSED_MESSAGE = `Your account is paused. Please contact ${branding.supportEmail} for help.`;
export const INVALID_LINK_ERROR = 'This link is invalid or has expired. Please request a new one.';
/** Forgot-password always answers this, whether or not the email exists. */
export const RESET_REQUESTED_MESSAGE =
  'If an account exists for that email, we have sent a link to reset the password.';
/** The forgot-password route always takes at least this long (hides timing differences). */
export const RESET_MIN_RESPONSE_MS = 250;