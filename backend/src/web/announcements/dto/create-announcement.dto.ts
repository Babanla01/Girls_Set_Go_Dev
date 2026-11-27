/**
 * create-announcement.dto.ts - a new announcement (it starts as a DRAFT).
 *   { "title": "Class moved to 5 PM", "message": "This week's class starts at 5 PM...",
 *     "audienceType": "COHORT", "cohortId": "<id>" }
 *   audienceType ALL_COHORTS  no ids        (admins only, if the setting allows it)
 *   audienceType TRACK        "trackId"     (admins only)
 *   audienceType COHORT       "cohortId"    (admins, and instructors for cohorts they teach)
 * Keep it short and actionable: plain text, 1500 characters at most, no HTML.
 */
import { AnnAudienceType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';

import { cleanLabel } from '../../../catalog/catalog.util';

export class CreateAnnouncementDto {
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(3, 120)
  title!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 1500)
  message!: string;

  @IsEnum(AnnAudienceType)
  audienceType!: AnnAudienceType;

  @IsOptional()
  @IsUUID()
  trackId?: string;

  @IsOptional()
  @IsUUID()
  cohortId?: string;
}