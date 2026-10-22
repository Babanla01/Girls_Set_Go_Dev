/**
 * create-cohort.dto.ts - what an admin sends to create a cohort.
 * Dates are plain calendar dates ("2026-11-03"). Capacity is optional.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

import { cleanLabel } from '../../../catalog/catalog.util';
import { IsCalendarDate } from '../../../common/validation/calendar-date.decorator';

export class CreateCohortDto {
  /** The course this cohort follows (the track comes from the course). */
  @IsUUID()
  courseId!: string;

  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 120)
  name!: string;

  @IsCalendarDate()
  startsOn!: string;

  @IsCalendarDate()
  endsOn!: string;

  /** Maximum number of students. Leave out for "no limit". */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  capacity?: number;
}