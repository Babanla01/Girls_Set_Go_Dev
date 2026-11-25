/**
 * update-banner.dto.ts - change a slide. Send only what should change.
 * Send null to clear: videoId, startsAt, endsAt. "placements" replaces the list of pages.
 */
import { CmsBannerMediaType, CmsBannerPage } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';

export class UpdateBannerDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 60)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(160)
  tagline?: string;

  @IsOptional()
  @IsEnum(CmsBannerMediaType)
  mediaType?: CmsBannerMediaType;

  @IsOptional()
  @IsUUID()
  imageAssetId?: string;

  @IsOptional()
  @IsUUID()
  videoId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsEnum(CmsBannerPage, { each: true })
  placements?: CmsBannerPage[];

  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @IsDateString()
  endsAt?: string | null;
}