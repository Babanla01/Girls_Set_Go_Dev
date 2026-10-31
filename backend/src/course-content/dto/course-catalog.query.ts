/**
 * course-catalog.query.ts
 * ---------------------------------------------------------------------------
 *   ?trackId=<uuid>&status=PUBLISHED&search=intro&page=1&pageSize=20
 */
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CourseStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../common/pagination/pagination';

export class CourseCatalogQuery extends PaginationQueryDto {
  /** Matches part of the course title, ignoring capitals. */
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
}
