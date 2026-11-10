/**
 * site-settings.definitions.ts
 * ---------------------------------------------------------------------------
 * The website's settings: what each one is, what values are allowed, and its
 * starting value. An admin changes them through PATCH /api/v1/admin/settings;
 * visitors read the result from GET /api/v1/public/site.
 *
 * "Applications open" is the ONE switch behind several things at once: the
 * announcement bar text, the bootcamp page state and the main button
 * (Apply now / Notify me). It is also enforced on the server (see
 * applications-open.guard.ts), so closing applications really closes them.
 */
import { z } from 'zod';

import { defineSetting } from '../../../platform/settings/settings.registry';

const GROUP = 'site';

/** "2027-01-18" - and it must be a real calendar day. */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'That is not a real date.');

export const SITE_SETTING_DEFINITIONS = [
  defineSetting<boolean>({
    key: 'site.applications_open',
    group: GROUP,
    label: 'Applications are open',
    description: 'Switches the announcement bar, the bootcamp page state and the main button (Apply now / Notify me).',
    schema: z.boolean(),
    defaultValue: true,
    isPublic: true,
  }),
  defineSetting<string | null>({
    key: 'site.next_cohort_start',
    group: GROUP,
    label: 'Next cohort starts on',
    description: 'Shown on the website. Leave empty if not decided.',
    schema: calendarDate.nullable(),
    defaultValue: null,
    isPublic: true,
  }),
  defineSetting<string | null>({
    key: 'site.applications_reopen_date',
    group: GROUP,
    label: 'Applications reopen on',
    description: 'Shown while applications are closed. Leave empty if not decided.',
    schema: calendarDate.nullable(),
    defaultValue: null,
    isPublic: true,
  }),
  defineSetting<string>({
    key: 'site.eligibility_statement',
    group: GROUP,
    label: 'Who can apply',
    description: 'One sentence shown on the application page.',
    schema: z.string().trim().max(300),
    defaultValue: '',
    isPublic: true,
  }),
  defineSetting<string>({
    key: 'site.announcement_bar_open',
    group: GROUP,
    label: 'Announcement bar text (applications open)',
    description: 'Leave empty to hide the bar while applications are open.',
    schema: z.string().trim().max(200),
    defaultValue: '',
    isPublic: true,
  }),
  defineSetting<string>({
    key: 'site.announcement_bar_closed',
    group: GROUP,
    label: 'Announcement bar text (applications closed)',
    description: 'Leave empty to hide the bar while applications are closed.',
    schema: z.string().trim().max(200),
    defaultValue: '',
    isPublic: true,
  }),
  defineSetting<string | null>({
    key: 'site.contact_email',
    group: GROUP,
    label: 'Contact email',
    schema: z.email().max(254).nullable(),
    defaultValue: null,
    isPublic: true,
  }),
  defineSetting<string | null>({
    key: 'site.contact_phone',
    group: GROUP,
    label: 'Contact phone',
    schema: z.string().trim().max(30).nullable(),
    defaultValue: null,
    isPublic: true,
  }),
  defineSetting<string | null>({
    key: 'site.contact_address',
    group: GROUP,
    label: 'Contact address',
    description: 'Only shown to visitors once "Address confirmed" is switched on.',
    schema: z.string().trim().max(300).nullable(),
    defaultValue: null,
    isPublic: false, // shown only through the site view, and only when confirmed
  }),
  defineSetting<boolean>({
    key: 'site.contact_address_confirmed',
    group: GROUP,
    label: 'Address confirmed',
    description: 'Until this is on, no address is shown anywhere on the website.',
    schema: z.boolean(),
    defaultValue: false,
    isPublic: true,
  }),
  defineSetting<string>({
    key: 'site.tagline_text',
    group: GROUP,
    label: 'Scrolling tagline',
    description: 'The line that scrolls under the top banner.',
    schema: z.string().trim().min(1).max(200),
    defaultValue: 'Exploring Creativity Through Design • Build. Try. Learn. • Made by girls in STEM',
    isPublic: true,
  }),
  defineSetting<number>({
    key: 'site.tagline_speed_px_per_second',
    group: GROUP,
    label: 'Tagline speed (pixels per second)',
    description: 'The design starts at 40 (slow).',
    schema: z.number().int().min(10).max(200),
    defaultValue: 40,
    isPublic: true,
  }),
  defineSetting<number>({
    key: 'site.banner_interval_ms',
    group: GROUP,
    label: 'Banner: time on each slide (milliseconds)',
    schema: z.number().int().min(3000).max(20000),
    defaultValue: 6000,
    isPublic: true,
  }),
  defineSetting<number>({
    key: 'site.banner_fade_ms',
    group: GROUP,
    label: 'Banner: fade between slides (milliseconds)',
    schema: z.number().int().min(0).max(2000),
    defaultValue: 600,
    isPublic: true,
  }),
  defineSetting<number>({
    key: 'site.banner_overlay_opacity',
    group: GROUP,
    label: 'Banner: darkness of the colour layer (0 to 1)',
    schema: z.number().min(0).max(1),
    defaultValue: 0.66,
    isPublic: true,
  }),
];