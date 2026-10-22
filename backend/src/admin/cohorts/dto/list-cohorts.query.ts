/**
 * list-cohorts.query.ts
 * ---------------------------------------------------------------------------
 *   ?courseId=<uuid>&trackId=<uuid>&status=ACTIVE&phase=running&search=2026
 *   &sortBy=startsOn&sortDir=desc&page=1&pageSize=20
 */
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CohortStatus } from '@prisma/client';

import { COHORT_PHASES, CohortPhase } from '../../../catalog/catalog.util';
import { PaginationQueryDto } from '../../../common/pagination/pagination';

export const COHORT_SORT_FIELDS = ['startsOn', 'name', 'createdAt'] as const;

export class ListCohortsQuery extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsUUID()
  trackId?: string;

  @IsOptional()
  @IsEnum(CohortStatus)
  status?: CohortStatus;

  /** upcoming = not started yet, running = in progress, ended = finished. */
  @IsOptional()
  @IsIn(COHORT_PHASES)
  phase?: CohortPhase;

  @IsOptional()
  @IsIn(COHORT_SORT_FIELDS)
  sortBy: (typeof COHORT_SORT_FIELDS)[number] = 'startsOn';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'desc';
}