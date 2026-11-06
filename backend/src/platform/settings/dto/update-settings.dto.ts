/**
 * update-settings.dto.ts
 * ---------------------------------------------------------------------------
 *   PATCH /api/v1/admin/settings
 *   { "values": { "site.applications_open": false, "site.next_cohort_start": "2027-01-18" } }
 * Every value is checked against the rule of its setting; see the registry.
 */
import { IsObject } from 'class-validator';

export class UpdateSettingsDto {
  @IsObject()
  values!: Record<string, unknown>;
}