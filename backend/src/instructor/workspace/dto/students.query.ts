/**
 * students.query.ts
 * ---------------------------------------------------------------------------
 *   ?search=ada                          part of a student's name
 *   &courseId=<uuid>&cohortId=<uuid>     narrow to one course / cohort
 *   &status=NEEDS_REVIEW|NEEDS_ATTENTION|ON_TRACK|INACTIVE|ALL   (default ALL)
 *   &page=1&pageSize=20                  (the CSV export ignores paging)
 */
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../common/pagination/pagination';
import { STUDENT_STATUSES } from '../student-status';

export const STUDENT_STATUS_FILTERS = [...STUDENT_STATUSES, 'ALL'] as const;
export type StudentStatusFilter = (typeof STUDENT_STATUS_FILTERS)[number];

export class StudentsQuery extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @IsOptional()
  @IsIn(STUDENT_STATUS_FILTERS)
  status?: StudentStatusFilter;
}
