/**
 * create-video.dto.ts - a new video (it starts as a DRAFT).
 *
 *   an uploaded video:   { "title": "...", "source": "UPLOAD", "category": "AI_ROBOTICS" }
 *                        then send the file with  PUT /api/v1/admin/videos/:id/file
 *   an embedded video:   { "title": "...", "source": "YOUTUBE", "url": "https://youtu.be/...", "category": "...", "durationSeconds": 95 }
 */
import { CmsVideoCategory, CmsVideoSource } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsEnum, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';
import { MAX_EXTRA_TAGS, VIDEO_MAX_SECONDS } from '../video.constants';

export class CreateVideoDto {
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 120)
  title!: string;

  @IsEnum(CmsVideoSource)
  source!: CmsVideoSource;

  /** The YouTube or Vimeo link (not for an uploaded video). */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  url?: string;

  @IsEnum(CmsVideoCategory)
  category!: CmsVideoCategory;

  @IsOptional()
  @ArrayMaxSize(MAX_EXTRA_TAGS)
  @ArrayUnique()
  @IsEnum(CmsVideoCategory, { each: true })
  alsoTagged?: CmsVideoCategory[];

  /** A line shown when someone hovers over the video card: 120 characters at most. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  hoverDescription?: string;

  /** For an embedded video only: how long it runs, in seconds (an uploaded file tells us itself). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_SECONDS)
  durationSeconds?: number;
}