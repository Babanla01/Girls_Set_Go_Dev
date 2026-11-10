/**
 * site.service.ts
 * ---------------------------------------------------------------------------
 * The public face of the website settings: one small, safe JSON object that the
 * website reads to decide what to show (the announcement bar, whether the main
 * button says "Apply now" or "Notify me", contact details, the tagline and the
 * banner rules).
 *
 * Only what is meant to be public is included. An address is left out until an
 * admin confirms it.
 */
import { Injectable } from '@nestjs/common';

import { SettingsService } from '../../../platform/settings/settings.service';

@Injectable()
export class SiteService {
  constructor(private readonly settings: SettingsService) {}

  async publicView() {
    const s = await this.settings.getGroup('site');

    const open = s['site.applications_open'] as boolean;
    const barText = (open ? s['site.announcement_bar_open'] : s['site.announcement_bar_closed']) as string;
    const addressConfirmed = s['site.contact_address_confirmed'] as boolean;

    return {
      applications: {
        open,
        /** What the main button should offer. */
        primaryAction: open ? ('APPLY' as const) : ('NOTIFY_ME' as const),
        nextCohortStart: s['site.next_cohort_start'] as string | null,
        reopenDate: s['site.applications_reopen_date'] as string | null,
        eligibilityStatement: (s['site.eligibility_statement'] as string) || null,
      },
      announcementBar: barText ? { text: barText } : null,
      contact: {
        email: s['site.contact_email'] as string | null,
        phone: s['site.contact_phone'] as string | null,
        address: addressConfirmed ? (s['site.contact_address'] as string | null) : null,
      },
      tagline: {
        text: s['site.tagline_text'] as string,
        speedPxPerSecond: s['site.tagline_speed_px_per_second'] as number,
      },
      banner: {
        intervalMs: s['site.banner_interval_ms'] as number,
        fadeMs: s['site.banner_fade_ms'] as number,
        overlayOpacity: s['site.banner_overlay_opacity'] as number,
        // Fixed accessibility rules (not settings): the banner must always pause on
        // hover, focus and tap, offer a visible pause button, and stand still when
        // the visitor's device asks for reduced motion.
        pauseOnHover: true,
        pauseOnFocus: true,
        pauseOnTap: true,
        showPauseButton: true,
        respectReducedMotion: true,
      },
    };
  }
}