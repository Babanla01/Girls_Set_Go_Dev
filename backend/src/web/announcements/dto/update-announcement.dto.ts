/**
 * update-announcement.dto.ts - change an announcement. Send only what should change.
 * The title and message can be edited at any time (a published one then shows "Edited ...");
 * the audience can only be changed while it is still a draft.
 */
import { AnnAudienceType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';

import { cleanLabel } from '../../../catalog/catalog.util';

export class UpdateAnnouncementDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(3, 120)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 1500)
  message?: string;

  @IsOptional()
  @IsEnum(AnnAudienceType)
  audienceType?: AnnAudienceType;

  @IsOptional()
  @IsUUID()
  trackId?: string;

  @IsOptional()
  @IsUUID()
  cohortId?: string;
}