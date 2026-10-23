/**
 * list-students.query.ts
 * ---------------------------------------------------------------------------
 *   ?search=ada&applicationStatus=ACCEPTED&accountStatus=ACTIVE&trackId=<uuid>
 *   &cohortId=<uuid>&sortBy=name&sortDir=asc&page=1&pageSize=20
 * "trackId" and "cohortId" look at the student's CURRENT (active) enrollment.
 */
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AccountStatus, ApplicationStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination';

export const STUDENT_SORT_FIELDS = ['name', 'createdAt'] as const;

export class ListStudentsQuery extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsEnum(ApplicationStatus)
  applicationStatus?: ApplicationStatus;

  @IsOptional()
  @IsEnum(AccountStatus)
  accountStatus?: AccountStatus;

  @IsOptional()
  @IsUUID()
  trackId?: string;

  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @IsOptional()
  @IsIn(STUDENT_SORT_FIELDS)
  sortBy: (typeof STUDENT_SORT_FIELDS)[number] = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'desc';
}