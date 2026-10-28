/**
 * email.templates.ts
 * ---------------------------------------------------------------------------
 * Turns a queued email ("template name + values") into the real message: a
 * subject, a plain-text version and a simple HTML version.
 *
 * Rules these templates follow:
 *   - EVERY value is escaped before it goes into the HTML, so a name like
 *     "<script>" can never become markup;
 *   - a link is used only if it starts with http:// or https://;
 *   - the decline email gives NO reason and never mentions the private note;
 *   - an unknown template, or a missing link where one is needed, returns
 *     null (the sender then marks the email as failed instead of sending
 *     something broken).
 */
import { RESET_LINK_TTL_MS, VERIFY_LINK_TTL_MS } from '../../auth/auth.constants';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Payload = Record<string, unknown>;

interface Content {
  subject: string;
  greeting: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footer?: string;
}

const BRAND = 'Girls Set Go';
const HOUR_MS = 60 * 60 * 1000;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Only ordinary web links are allowed in emails. */
const safeUrl = (value: unknown): string | null => {
  const url = str(value);
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "24 hours" or "7 days" - whichever reads best for the lifetime of a link. */
const lifetime = (ms: number): string => {
  const hours = Math.round(ms / HOUR_MS);
  return hours % 24 === 0 && hours >= 48 ? plural(hours / 24, 'day') : plural(hours, 'hour');
};

const greeting = (payload: Payload): string => (str(payload.fullName) ? `Hello ${str(payload.fullName)},` : 'Hello,');

const BUILDERS: Record<string, (payload: Payload) => Content | null> = {
  'verify-email': (p) => {
    const url = safeUrl(p.actionUrl);
    if (!url) return null;
    return {
      subject: 'Please confirm your email address',
      greeting: greeting(p),
      paragraphs: [`Thank you for applying to ${BRAND}. Please confirm that this email address is yours.`],
      action: { label: 'Confirm my email address', url },
      footer: `This link works once and expires in ${lifetime(VERIFY_LINK_TTL_MS)}. If you did not apply, you can ignore this email.`,
    };
  },

  'application-received': (p) => ({
    subject: 'We received your application',
    greeting: greeting(p),
    paragraphs: [
      str(p.preferredTrack)
        ? `Thank you for applying to ${BRAND}. We have received your application for the ${str(p.preferredTrack)} track.`
        : `Thank you for applying to ${BRAND}. We have received your application.`,
      'Our team will review it and email you as soon as a decision has been made.',
    ],
  }),

  'application-accepted': (p) => {
    const url = safeUrl(p.actionUrl);
    if (!url) return null;
    const details = [
      str(p.trackName) && `Track: ${str(p.trackName)}`,
      str(p.courseTitle) && `Course: ${str(p.courseTitle)}`,
      str(p.cohortName) && `Cohort: ${str(p.cohortName)}`,
      str(p.startsOn) && str(p.endsOn) && `Runs from ${str(p.startsOn)} to ${str(p.endsOn)}`,
    ].filter((line): line is string => Boolean(line));

    return {
      subject: 'Your application was accepted',
      greeting: greeting(p),
      paragraphs: ['Congratulations! Your application to Girls Set Go has been accepted.', ...details],
      action: { label: 'Sign in to start learning', url },
    };
  },

  // No reason is ever given here, and the private admin note is never included.
  'application-declined': (p) => ({
    subject: 'About your application',
    greeting: greeting(p),
    paragraphs: [
      `Thank you for your interest in ${BRAND}.`,
      'After careful review, we are unable to offer you a place at this time. We appreciate the time you took to apply.',
    ],
  }),

  'password-reset': (p) => {
    const url = safeUrl(p.actionUrl);
    if (!url) return null;
    const minutes = typeof p.expiresInMinutes === 'number' ? p.expiresInMinutes : RESET_LINK_TTL_MS / 60_000;
    return {
      subject: 'Reset your password',
      greeting: greeting(p),
      paragraphs: ['We received a request to reset the password for your account.'],
      action: { label: 'Choose a new password', url },
      footer: `This link works once and expires in ${plural(minutes, 'minute')}. If you did not ask for this, you can ignore this email and your password will stay the same.`,
    };
  },

  'instructor-invite': (p) => {
    const url = safeUrl(p.actionUrl);
    if (!url) return null;
    const days = typeof p.expiresInDays === 'number' ? p.expiresInDays : 7;
    return {
      subject: `You have been invited to teach at ${BRAND}`,
      greeting: greeting(p),
      paragraphs: [
        str(p.invitedBy)
          ? `${str(p.invitedBy)} has invited you to join ${BRAND} as an instructor.`
          : `You have been invited to join ${BRAND} as an instructor.`,
        'Please choose a password to activate your account.',
      ],
      action: { label: 'Set my password', url },
      footer: `This link works once and expires in ${plural(days, 'day')}.`,
    };
  },
};

function build(content: Content): RenderedEmail {
  const signOff = `The ${BRAND} team`;

  const text = [
    content.greeting,
    '',
    ...content.paragraphs.flatMap((paragraph) => [paragraph, '']),
    ...(content.action ? [`${content.action.label}:`, content.action.url, ''] : []),
    ...(content.footer ? [content.footer, ''] : []),
    signOff,
  ].join('\n');

  const paragraphs = content.paragraphs
    .map((paragraph) => `<p style="margin:0 0 14px;line-height:1.5;">${escapeHtml(paragraph)}</p>`)
    .join('\n');

  const action = content.action
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(content.action.url)}" style="background:#6b21a8;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">${escapeHtml(content.action.label)}</a></p>
<p style="margin:0 0 14px;font-size:12px;color:#666666;line-height:1.5;">If the button does not work, copy this link into your browser:<br>${escapeHtml(content.action.url)}</p>`
    : '';

  const footer = content.footer
    ? `<p style="margin:0 0 14px;font-size:12px;color:#666666;line-height:1.5;">${escapeHtml(content.footer)}</p>`
    : '';

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#222222;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px;">
<h2 style="margin:0 0 20px;color:#6b21a8;">${escapeHtml(BRAND)}</h2>
<p style="margin:0 0 14px;">${escapeHtml(content.greeting)}</p>
${paragraphs}
${action}
${footer}
<p style="margin:20px 0 0;">${escapeHtml(signOff)}</p>
</div>
</body>
</html>`;

  return { subject: content.subject, text, html };
}

/** The message for a queued email, or null when it cannot be built. */
export function renderEmail(template: string, payload: unknown): RenderedEmail | null {
  // Own keys only, so a name like "constructor" can never pick up a built-in.
  if (!Object.prototype.hasOwnProperty.call(BUILDERS, template)) return null;
  const builder = BUILDERS[template];

  const values: Payload = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Payload) : {};
  const content = builder(values);
  return content ? build(content) : null;
}

/** Names of every template this file can build (handy for tests). */
export const KNOWN_EMAIL_TEMPLATES = Object.keys(BUILDERS);