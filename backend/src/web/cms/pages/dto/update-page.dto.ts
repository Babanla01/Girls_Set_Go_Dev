/**
 * update-page.dto.ts - change a page's name or address. Send only what changes.
 * The address can only change while the page has never been published.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';

export class UpdatePageDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 150)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 120)
  path?: string;
}