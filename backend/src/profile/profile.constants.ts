/**
 * profile.constants.ts
 * ---------------------------------------------------------------------------
 * The limits and the choices of the student profile, in ONE place.
 */

/**
 * The "After the bootcamp I'd like to..." choices. The database stores the KEY, so changing a
 * label - or adding a choice - never needs a migration.
 */
export const AFTER_BOOTCAMP_CHOICES = [
  { key: 'STUDY_FURTHER', label: 'Study further' },
  { key: 'START_WORKING', label: 'Start working' },
  { key: 'BUILD_OWN_PROJECTS', label: 'Build my own projects' },
  { key: 'JOIN_TALENT_ACADEMY', label: 'Join the Talent Academy' },
  { key: 'NOT_SURE_YET', label: 'Not sure yet' },
] as const;

export type AfterBootcampKey = (typeof AFTER_BOOTCAMP_CHOICES)[number]['key'];

export const AFTER_BOOTCAMP_KEYS: readonly AfterBootcampKey[] = AFTER_BOOTCAMP_CHOICES.map((choice) => choice.key);

export const afterBootcampLabel = (key: string | null): string | null =>
  AFTER_BOOTCAMP_CHOICES.find((choice) => choice.key === key)?.label ?? null;

/** Interests are short "chips": at most 10, each at most 30 characters. */
export const MAX_INTERESTS = 10;
export const MAX_INTEREST_LENGTH = 30;

/** The goal for the bootcamp: 280 characters at most. */
export const MAX_GOAL_LENGTH = 280;

/** Shown when someone tries to change what only support may change (PRF-02). */
export const SUPPORT_ONLY_MESSAGE =
  'To change your name, email, date of birth, location or guardian details, please contact support.';

/** Who can see the interests and the goal (PRF-03). */
export const VISIBILITY_NOTE =
  'Only you, your instructor and the Girls Set Go team can see your interests and goals. They are never shown on the public website.';
