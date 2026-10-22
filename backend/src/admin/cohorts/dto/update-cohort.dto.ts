/**
 * update-cohort.dto.ts - what an admin may change on a cohort. Send only what
 * should change. Send `"capacity": null` to remove the limit.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { cleanLabel } from '../../../catalog/catalog.util';
import { IsCalendarDate } from '../../../common/validation/calendar-date.decorator';

export class UpdateCohortDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsCalendarDate()
  startsOn?: string;

  @IsOptional()
  @IsCalendarDate()
  endsOn?: string;

  /** A number sets the limit; null removes it. (IsOptional lets null through on purpose.) */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  capacity?: number | null;
}