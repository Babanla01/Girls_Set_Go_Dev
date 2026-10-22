/**
 * list-instructors.query.ts
 * ---------------------------------------------------------------------------
 * The filters an admin can put on the instructor list:
 *   ?page=1&pageSize=20&search=ada&status=ACTIVE&sortBy=fullName&sortDir=asc
 * Every value is checked; anything unexpected is rejected.
 */
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AccountStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination';

export const INSTRUCTOR_SORT_FIELDS = ['createdAt', 'fullName', 'email', 'lastLoginAt'] as const;
export type InstructorSortField = (typeof INSTRUCTOR_SORT_FIELDS)[number];

export class ListInstructorsQuery extends PaginationQueryDto {
  /** Matches part of the name or email, ignoring capitals. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @IsOptional()
  @IsIn(INSTRUCTOR_SORT_FIELDS)
  sortBy: InstructorSortField = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'desc';
}