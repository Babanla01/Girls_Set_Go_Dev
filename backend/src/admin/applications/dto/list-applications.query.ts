/**
 * list-applications.query.ts
 * ---------------------------------------------------------------------------
 *   ?status=PENDING&preferredTrackId=<uuid>&search=ada&from=2026-10-01&to=2026-10-31
 *   &sortBy=submittedAt&sortDir=desc&page=1&pageSize=20
 */
import { Transform, Type } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApplicationStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination';

export const APPLICATION_SORT_FIELDS = ['submittedAt', 'name'] as const;

export class ListApplicationsQuery extends PaginationQueryDto {
  /** Matches part of the applicant's name or email, ignoring capitals. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsEnum(ApplicationStatus)
  status?: ApplicationStatus;

  @IsOptional()
  @IsUUID()
  preferredTrackId?: string;

  /** Submitted on or after this date/time. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /** Submitted on or before this date/time. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsIn(APPLICATION_SORT_FIELDS)
  sortBy: (typeof APPLICATION_SORT_FIELDS)[number] = 'submittedAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'desc';
}