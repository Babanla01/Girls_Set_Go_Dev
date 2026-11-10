/**
 * replace-media.dto.ts - sent with the NEW picture file when replacing one.
 * The key (the picture's permanent name) stays the same.
 *   altText  optional new alt text; leave out to keep the old one
 *   consent  "true" is required again for pictures in the PEOPLE and PROJECTS folders
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

import { toBoolean } from './upload-media.dto';

export class ReplaceMediaDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @Length(3, 250, { message: 'Alt text must describe the picture in a few words.' })
  altText?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  consent?: boolean;
}