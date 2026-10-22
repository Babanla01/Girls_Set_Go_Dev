/**
 * create-track.dto.ts - what an admin sends to create a track.
 * Extra fields (like "status") are rejected: new tracks always start ACTIVE.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

import { cleanLabel } from '../../../catalog/catalog.util';

export class CreateTrackDto {
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  description?: string;
}