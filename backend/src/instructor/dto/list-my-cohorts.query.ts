/**
 * list-my-cohorts.query.ts
 * ---------------------------------------------------------------------------
 * What an instructor can ask when listing THEIR cohorts:
 *   ?status=ACTIVE (default) or ARCHIVED, plus ?page= and ?pageSize=
 */
import { IsEnum, IsOptional } from 'class-validator';
import { CohortStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../common/pagination/pagination';

export class ListMyCohortsQuery extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(CohortStatus)
  status: CohortStatus = CohortStatus.ACTIVE;
}