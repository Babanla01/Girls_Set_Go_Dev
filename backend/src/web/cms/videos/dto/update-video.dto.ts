/**
 * update-video.dto.ts - change a video. Send only what should change.
 * Send null to clear: thumbnailAssetId, consentSignedOn, postedOn.
 * (The length of an UPLOADED video comes from the file itself and cannot be typed in.)
 */
import { CmsVideoCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';
import { IsCalendarDate } from '../../../../common/validation/calendar-date.decorator';
import { MAX_EXTRA_TAGS, MAX_PEOPLE_IN_VIDEO, VIDEO_MAX_SECONDS } from '../video.constants';

export class UpdateVideoDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 120)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  hoverDescription?: string;

  @IsOptional()
  @IsEnum(CmsVideoCategory)
  category?: CmsVideoCategory;

  @IsOptional()
  @ArrayMaxSize(MAX_EXTRA_TAGS)
  @ArrayUnique()
  @IsEnum(CmsVideoCategory, { each: true })
  alsoTagged?: CmsVideoCategory[];

  /** The YouTube or Vimeo link (embedded videos only). */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  url?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_SECONDS)
  durationSeconds?: number;

  /** A picture from the Videos folder of the media library (16:9, at least 1280 x 720). null removes it. */
  @IsOptional()
  @IsUUID()
  thumbnailAssetId?: string | null;

  @IsOptional()
  @IsBoolean()
  showsLearners?: boolean;

  /** Learners shown as first name + last initial. "Ada Okoye" is saved as "Ada O." */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PEOPLE_IN_VIDEO)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  peopleInVideo?: string[];

  /** The date the guardians signed the consent (YYYY-MM-DD). null removes it. */
  @IsOptional()
  @IsCalendarDate()
  consentSignedOn?: string | null;

  /** The posted date shown on the website (YYYY-MM-DD). */
  @IsOptional()
  @IsCalendarDate()
  postedOn?: string | null;

  @IsOptional()
  @IsBoolean()
  showOnHome?: boolean;

  @IsOptional()
  @IsBoolean()
  showOnStudio?: boolean;

  @IsOptional()
  @IsBoolean()
  showOnShowcase?: boolean;

  @IsOptional()
  @IsBoolean()
  featured?: boolean;
}