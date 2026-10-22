/**
 * update-course.dto.ts - what an admin may change on a course: title and/or
 * description. (Moving a course to another track is not allowed: students and
 * cohorts depend on where it lives.) An empty description ("") clears it.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

import { cleanLabel } from '../../../catalog/catalog.util';

export class UpdateCourseDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 150)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(5000)
  description?: string;
}