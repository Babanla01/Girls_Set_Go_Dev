/**
 * announcement.settings.ts
 * ---------------------------------------------------------------------------
 * The one setting of the announcements feature, changed by an admin in
 * PATCH /api/v1/admin/settings.
 *
 *   announcements.admin_scope
 *     ANY               an admin may write to ALL active cohorts, to one track, or to one cohort
 *     TRACK_OR_COHORT   an admin may only write to one track or one cohort
 *
 * (Instructors may only ever write to a cohort they teach, whatever this says.)
 */
import { z } from 'zod';

import { defineSetting } from '../../platform/settings/settings.registry';

export const ANNOUNCEMENT_SETTING_DEFINITIONS = [
  defineSetting<'ANY' | 'TRACK_OR_COHORT'>({
    key: 'announcements.admin_scope',
    group: 'announcements',
    label: 'Who an admin can write to',
    description: 'ANY = all active cohorts, a track or a cohort. TRACK_OR_COHORT = a track or a cohort only.',
    schema: z.enum(['ANY', 'TRACK_OR_COHORT']),
    defaultValue: 'ANY',
    isPublic: false,
  }),
];