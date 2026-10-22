/**
 * update-track.dto.ts - what an admin may change on a track: name and/or
 * description. Send only what should change. An empty description ("") clears it.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

import { cleanLabel } from '../../../catalog/catalog.util';

export class UpdateTrackDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 100)
  name?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  description?: string;
}