/**
 * lesson.dto.ts - what the screen may send when adding, editing or moving a lesson.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';

import { cleanLabel } from '../../catalog/catalog.util';
import { LIMITS } from '../course-content.constants';

const label = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanLabel(value) : value);
const textOrUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);
const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class CreateLessonDto {
  @Transform(label)
  @IsString()
  @Length(2, LIMITS.title)
  title!: string;

  @IsOptional()
  @Transform(textOrUndefined)
  @IsString()
  @MaxLength(LIMITS.summary)
  summary?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(LIMITS.minutes)
  estimatedMinutes?: number;

  /** Where to put it in the week (1 = first). Leave out to add it at the end. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  position?: number;
}

export class UpdateLessonDto {
  @IsOptional()
  @Transform(label)
  @IsString()
  @Length(2, LIMITS.title)
  title?: string;

  /** A text sets it; null (or an empty box) clears it. */
  @IsOptional()
  @Transform(textOrNull)
  @IsString()
  @MaxLength(LIMITS.summary)
  summary?: string | null;

  /** A number sets it; null clears it. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(LIMITS.minutes)
  estimatedMinutes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}

export class MoveLessonDto {
  /** The week to move the lesson to (it may be the same week, to change its place). */
  @IsUUID()
  weekId!: string;

  /** Its new place in that week (1 = first). Leave out to put it last. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  position?: number;
}
