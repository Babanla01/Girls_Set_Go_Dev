/**
 * create-banner.dto.ts - a new banner slide (it starts as a DRAFT).
 *   {
 *     "title": "A future she can build", "tagline": "Free tech training for girls",
 *     "mediaType": "PHOTO", "imageAssetId": "<id from the media library>",
 *     "placements": ["HOME", "CREATIVE_STUDIO"],
 *     "startsAt": "2027-01-01T00:00:00Z", "endsAt": "2027-03-01T00:00:00Z"      (the schedule is optional)
 *   }
 * A VIDEO slide also needs "videoId" (an uploaded video); its picture is shown until the video
 * loads and to visitors who asked for reduced motion.
 */
import { CmsBannerMediaType, CmsBannerPage } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';

export class CreateBannerDto {
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 60)
  title!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(160)
  tagline?: string;

  @IsEnum(CmsBannerMediaType)
  mediaType!: CmsBannerMediaType;

  @IsUUID()
  imageAssetId!: string;

  @IsOptional()
  @IsUUID()
  videoId?: string;

  /** The pages that show this slide (each page keeps its own order). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsEnum(CmsBannerPage, { each: true })
  placements!: CmsBannerPage[];

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;
}