/**
 * review.dto.ts - what the instructor sends when saving a review.
 *
 * Every review has all four scores (1 to 4), one strength and one next step, plus the outcome.
 * `versionNumber` is the version she was looking at: if the student sent a newer one meanwhile,
 * the save is refused instead of being applied to work the instructor never saw.
 */
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { ReviewOutcome } from '@prisma/client';

import { MAX_REVISION_DAYS } from '../grading.constants';

/** Keeps line breaks, trims the ends. */
const feedbackText = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : value);

export class ScoresDto {
  @IsInt() @Min(1) @Max(4) understanding!: number;
  @IsInt() @Min(1) @Max(4) execution!: number;
  @IsInt() @Min(1) @Max(4) testing!: number;
  @IsInt() @Min(1) @Max(4) communication!: number;
}

export class ReviewDto {
  /** The version being reviewed (the latest one). */
  @IsInt()
  @Min(1)
  versionNumber!: number;

  @ValidateNested()
  @Type(() => ScoresDto)
  scores!: ScoresDto;

  /** One thing the student did well. */
  @Transform(feedbackText)
  @IsString()
  @Length(1, 500)
  strength!: string;

  /** One thing to do next. */
  @Transform(feedbackText)
  @IsString()
  @Length(1, 500)
  nextStep!: string;

  @IsEnum(ReviewOutcome)
  outcome!: ReviewOutcome;

  /** Only with NEEDS_REVISION: days the student has to resubmit (default 7). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_REVISION_DAYS)
  revisionDays?: number;
}
