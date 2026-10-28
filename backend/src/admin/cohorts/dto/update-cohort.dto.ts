/**
 * update-cohort.dto.ts - what an admin may change on a cohort. Send only what
 * should change. Send `"capacity": null` to remove the limit.
 * `status` may be PLANNED or ACTIVE only: closing a cohort has its own action
 * (it checks that nobody is still enrolled).
 */
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { CohortStatus } from '@prisma/client';

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

  /** Start (ACTIVE) or un-start (PLANNED) a cohort by hand. */
  @IsOptional()
  @IsIn([CohortStatus.PLANNED, CohortStatus.ACTIVE])
  status?: 'PLANNED' | 'ACTIVE';
}