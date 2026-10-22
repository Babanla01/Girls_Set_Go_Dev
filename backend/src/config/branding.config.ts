/**
 * branding.config.ts
 * ---------------------------------------------------------------------------
 * The ONE place that holds organisation-specific identity: names, wording and
 * contact details. Nothing else in the codebase should hard-code "Girls Set Go".
 *
 * Why: if this product is ever adapted for another organisation, this file
 * (plus the logo/colours in the frontend) is where you start - not a search
 * through every file.
 *
 * Plain constants on purpose: these values are the same on every deployment
 * of this version, so they do not need to be environment variables.
 */
export const branding = {
  /** Shown in page titles and email headers. */
  platformName: 'Girls Set Go LMS',

  /** The organisation that runs the programme. */
  organisationName: 'Girls Set Go',

  /** Shown to users who need help. Replace with the real address. */
  supportEmail: 'support@girlssetgo.org',

  /**
   * The timezone the programme runs in. "Is this cohort running today?" is
   * answered using the calendar date IN THIS ZONE (a student in Lagos should
   * not see a cohort start an hour late because the server clock is in UTC).
   * Use an IANA name, e.g. 'Africa/Lagos'.
   */
  timezone: 'Africa/Lagos',

  /**
   * Wording used by the product. If an organisation prefers "Programme"
   * over "Track", change it here instead of editing screens or emails.
   */
  labels: {
    track: 'Track',
    cohort: 'Cohort',
    student: 'Student',
    instructor: 'Instructor',
    admin: 'Administrator',
  },
} as const;

export type Branding = typeof branding;