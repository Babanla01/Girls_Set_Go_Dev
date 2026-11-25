/**
 * badge-catalog.ts
 * ---------------------------------------------------------------------------
 * The six badges: their names and the plain-English "how to earn" shown to students.
 * (The rules that decide who has earned one are in badge-rules.ts.)
 */

export const BADGE_KEYS = [
  'WELCOME_ABOARD',
  'FIRST_SUBMISSION',
  'ON_TIME',
  'FEEDBACK_LOOP',
  'HALFWAY_THERE',
  'SHOWCASE_READY',
] as const;

export type BadgeKeyValue = (typeof BADGE_KEYS)[number];

export interface BadgeInfo {
  key: BadgeKeyValue;
  name: string;
  /** "How to earn" - shown for badges she has not earned yet. */
  howToEarn: string;
}

/** "Halfway there" is earned by finishing this week of the course. */
export const HALFWAY_WEEK = 4;

export const BADGES: readonly BadgeInfo[] = [
  { key: 'WELCOME_ABOARD', name: 'Welcome aboard', howToEarn: 'Join a cohort.' },
  { key: 'FIRST_SUBMISSION', name: 'First submission', howToEarn: 'Send in your first assignment.' },
  { key: 'ON_TIME', name: 'On time', howToEarn: 'Send an assignment before its due time.' },
  { key: 'FEEDBACK_LOOP', name: 'Feedback loop', howToEarn: 'Send a new version after you get feedback.' },
  {
    key: 'HALFWAY_THERE',
    name: 'Halfway there',
    howToEarn: `Finish Week ${HALFWAY_WEEK}: complete its lessons and get its assignment reviewed.`,
  },
  { key: 'SHOWCASE_READY', name: 'Showcase ready', howToEarn: "Get your final week's assignment marked complete." },
];

export const badgeInfo = (key: string): BadgeInfo | undefined => BADGES.find((badge) => badge.key === key);
