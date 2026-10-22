/**
 * list-courses.query.ts
 * ---------------------------------------------------------------------------
 *   ?trackId=<uuid>&status=PUBLISHED&search=intro&sortBy=title&sortDir=asc&page=1
 */
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CourseStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination';

export const COURSE_SORT_FIELDS = ['title', 'createdAt'] as const;

export class ListCoursesQuery extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(150)
  search?: string;

  @IsOptional()
  @IsUUID()
  trackId?: string;

  @IsOptional()
  @IsEnum(CourseStatus)
  status?: CourseStatus;

  @IsOptional()
  @IsIn(COURSE_SORT_FIELDS)
  sortBy: (typeof COURSE_SORT_FIELDS)[number] = 'title';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'asc';
}