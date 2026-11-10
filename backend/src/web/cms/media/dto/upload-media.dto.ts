/**
 * upload-media.dto.ts
 * ---------------------------------------------------------------------------
 * The text fields sent together with the picture file (a multipart form):
 *   file     the picture (JPG, PNG or WebP, up to 10 MB)
 *   folder   BRAND | BANNERS | SITE | PEOPLE | PROJECTS | PRODUCTS | VIDEOS
 *   title    a short name, also used to build the picture's permanent key
 *   altText  what a screen reader says about the picture (required)
 *   consent  "true" when everyone shown agreed to be published (required for PEOPLE and PROJECTS)
 */
import { CmsMediaFolder } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, Length } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';

/** Form fields arrive as text: "true", "1" and "on" all mean yes. */
export const toBoolean = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1' || value === 'on';

export class UploadMediaDto {
  @IsEnum(CmsMediaFolder)
  folder!: CmsMediaFolder;

  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 120)
  title!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 250, { message: 'Alt text is required: describe the picture in a few words.' })
  altText!: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  consent?: boolean;
}