/**
 * week.dto.ts - what the screen may send when adding or editing a week.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

import { cleanLabel } from '../../catalog/catalog.util';
import { LIMITS } from '../course-content.constants';

const label = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanLabel(value) : value);
/** Trims text; an empty box counts as "not provided". */
const textOrUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);
/** Trims text; an empty box clears the field (null). */
const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class CreateWeekDto {
  @Transform(label)
  @IsString()
  @Length(2, LIMITS.title)
  title!: string;

  @IsOptional()
  @Transform(textOrUndefined)
  @IsString()
  @MaxLength(LIMITS.summary)
  summary?: string;

  /** Where to put it (1 = first). Leave out to add it at the end. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  position?: number;
}

export class UpdateWeekDto {
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

  /** The revision the screen was showing. If someone saved since, the edit is refused. */
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
