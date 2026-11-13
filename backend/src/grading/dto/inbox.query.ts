/**
 * inbox.query.ts
 * ---------------------------------------------------------------------------
 *   ?status=WAITING|NEEDS_REVISION|REVIEWED|COMPLETED|ALL   (default WAITING: still to be reviewed)
 *   &cohortId=<uuid>&courseId=<uuid>                         narrow to one cohort / course
 *   &from=2026-10-01&to=2026-10-31                           last activity between these days (Chicago time)
 *   &search=ada   or   &search=GSG-SUB-12                    student name, or receipt number
 *   &page=1&pageSize=20
 */
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination/pagination';
import { IsCalendarDate } from '../../common/validation/calendar-date.decorator';

export const INBOX_STATUSES = ['WAITING', 'NEEDS_REVISION', 'REVIEWED', 'COMPLETED', 'ALL'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export class InboxQuery extends PaginationQueryDto {
  @IsOptional()
  @IsIn(INBOX_STATUSES)
  status?: InboxStatus;

  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  /** First day (inclusive), "YYYY-MM-DD". */
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  /** Last day (inclusive), "YYYY-MM-DD". */
  @IsOptional()
  @IsCalendarDate()
  to?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(100)
  search?: string;
}
