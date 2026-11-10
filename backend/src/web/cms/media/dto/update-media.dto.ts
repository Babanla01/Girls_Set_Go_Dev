/**
 * update-media.dto.ts - what can be changed about a picture without replacing it.
 * Send only what should change. The key and the folder never change.
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';

export class UpdateMediaDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 120)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 250, { message: 'Alt text is required: describe the picture in a few words.' })
  altText?: string;

  /** true = record the consent now. false removes it (not allowed for PEOPLE and PROJECTS). */
  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}