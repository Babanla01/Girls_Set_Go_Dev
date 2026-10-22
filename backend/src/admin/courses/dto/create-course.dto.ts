/**
 * create-course.dto.ts - what an admin sends to create a course inside a track.
 * New courses always start as DRAFT (extra fields like "status" are rejected).
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

import { cleanLabel } from '../../../catalog/catalog.util';

export class CreateCourseDto {
  /** The track this course belongs to. */
  @IsUUID()
  trackId!: string;

  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 150)
  title!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(5000)
  description?: string;
}