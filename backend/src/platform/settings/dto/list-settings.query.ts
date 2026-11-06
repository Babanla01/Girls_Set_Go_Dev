/**
 * list-settings.query.ts - GET /api/v1/admin/settings?group=site
 * (leave "group" out to list every setting).
 */
import { IsOptional, Matches } from 'class-validator';

export class ListSettingsQuery {
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'group must be a lowercase word such as "site".' })
  group?: string;
}