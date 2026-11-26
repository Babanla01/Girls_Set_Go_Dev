/**
 * notification.types.ts
 * ---------------------------------------------------------------------------
 * Every kind of notification in the bell, and how it reads.
 *
 * A notification is stored as a TYPE plus a small PAYLOAD of facts ("week 2",
 * "Screen redesign"). The wording is built from them HERE, when the bell is read,
 * so improving a sentence improves it for old notifications too.
 *
 * Rules for payloads (for whoever creates a notification):
 *   - facts only (names of things, numbers, a link) - NEVER feedback text, scores,
 *     passwords or one-time links: students are often minors and the bell is
 *     shown on screens other people may see;
 *   - "link" is a path on the website (for example "/learn/assignments"), never a
 *     web address.
 *
 * To add a type: add one entry below, then call
 *     notifications.notify(userId, 'your.type', { ...facts })
 */

export type NotificationAudience = 'STUDENT' | 'INSTRUCTOR' | 'ADMIN';

export interface NotificationView {
  title: string;
  body: string;
  /** A path on the website to open when the notification is tapped, or null. */
  link: string | null;
}

export interface NotificationTypeDefinition {
  /** Who this kind of notification is for (documentation; also used by tests). */
  audience: NotificationAudience;
  render: (payload: Record<string, unknown>) => NotificationView;
}

type Payload = Record<string, unknown>;

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : fallback);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

/** Only a path on this website is allowed as a link. */
const link = (value: unknown, fallback: string | null): string | null =>
  typeof value === 'string' && /^\/(?!\/)[^\s<>"'`\\]*$/.test(value) ? value : fallback;

export const NOTIFICATION_TYPES = {
  // ------------------------------------------------------------------ students
  'application.accepted': {
    audience: 'STUDENT',
    render: (p) => ({
      title: "You're accepted!",
      body: text(p.cohortName) ? `Welcome to ${text(p.cohortName)}. Your course is now open.` : 'Welcome to Girls Set Go. Your course is now open.',
      link: link(p.link, '/learn'),
    }),
  },
  'week.opened': {
    audience: 'STUDENT',
    render: (p) => {
      const week = count(p.weekNumber);
      const label = week === null ? 'A new week' : `Week ${week}`;
      const name = text(p.weekTitle) ? `${label} · ${text(p.weekTitle)}` : label;
      const reviewer = text(p.instructorName);
      const work = text(p.assignmentTitle);
      const outcome = p.outcome === 'NEEDS_REVISION' ? ' (needs revision)' : '';
      return {
        title: `${label} is open`,
        body: reviewer && work ? `${reviewer} graded "${work}"${outcome}, so ${name} is now open.` : `${name} is now open.`,
        link: link(p.link, '/learn'),
      };
    },
  },
  'feedback.ready': {
    audience: 'STUDENT',
    render: (p) => ({
      title: 'Your feedback is ready',
      body: text(p.assignmentTitle) ? `Feedback on "${text(p.assignmentTitle)}" is waiting for you in the portal.` : 'Feedback on your work is waiting for you in the portal.',
      link: link(p.link, '/learn/assignments'),
    }),
  },
  'recording.ready': {
    audience: 'STUDENT',
    render: (p) => {
      const week = count(p.weekNumber);
      return {
        title: 'Class recording ready',
        body: week === null ? 'The recording of your latest class is ready to watch.' : `The recording of the Week ${week} class is ready to watch.`,
        link: link(p.link, '/learn'),
      };
    },
  },
  'announcement.new': {
    audience: 'STUDENT',
    render: (p) => ({
      title: 'New announcement',
      body: text(p.title, 'Your learning team posted an update.'),
      link: link(p.link, '/learn/announcements'),
    }),
  },
  'course.changed': {
    audience: 'STUDENT',
    render: (p) => ({
      title: 'Your course was updated',
      body: text(p.summary) || (text(p.courseTitle) ? `${text(p.courseTitle)} has new or changed content.` : 'Your course has new or changed content.'),
      link: link(p.link, '/learn'),
    }),
  },

  // --------------------------------------------------------------- instructors
  'submissions.waiting': {
    audience: 'INSTRUCTOR',
    render: (p) => {
      const n = count(p.count);
      const cohort = text(p.cohortName);
      return {
        title: 'New submissions waiting',
        body: `${n === null ? 'New work is' : n === 1 ? '1 submission is' : `${n} submissions are`} waiting for your review${cohort ? ` in ${cohort}` : ''}.`,
        link: link(p.link, '/instructor/submissions'),
      };
    },
  },
  'template.update_pulled': {
    audience: 'INSTRUCTOR',
    render: (p) => ({
      title: 'Template update pulled',
      body: text(p.cohortName) ? `Updates from the course template were added to ${text(p.cohortName)}.` : 'Updates from the course template were added to your cohort.',
      link: link(p.link, '/instructor'),
    }),
  },
  'template.update_pushed': {
    audience: 'INSTRUCTOR',
    render: (p) => ({
      title: 'Template update pushed',
      body: text(p.cohortName) ? `An admin pushed template changes to ${text(p.cohortName)}.` : 'An admin pushed template changes to your cohort.',
      link: link(p.link, '/instructor'),
    }),
  },

  // -------------------------------------------------------------------- admins
  'application.new': {
    audience: 'ADMIN',
    render: (p) => ({
      title: 'New application',
      body: text(p.reference) ? `Application ${text(p.reference)} is waiting for a decision.` : 'A new application is waiting for a decision.',
      link: link(p.link, '/admin/applications'),
    }),
  },
  'email.acceptance_failed': {
    audience: 'ADMIN',
    render: (p) => ({
      title: 'Acceptance email failed',
      body: text(p.reference)
        ? `The acceptance email for application ${text(p.reference)} could not be sent. Please check it.`
        : 'An acceptance email could not be sent. Please check it.',
      link: link(p.link, '/admin/applications'),
    }),
  },
} satisfies Record<string, NotificationTypeDefinition>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export const isKnownNotificationType = (type: string): type is NotificationType =>
  Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPES, type);

/** How a stored notification reads. An unknown type (removed later) still shows something sensible. */
export function describeNotification(type: string, payload: unknown): NotificationView {
  const facts: Payload = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Payload) : {};
  if (!isKnownNotificationType(type)) return { title: 'Notification', body: '', link: null };
  return NOTIFICATION_TYPES[type].render(facts);
}