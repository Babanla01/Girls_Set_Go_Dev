
/**
 * list-my-cohorts.query.ts
 * ---------------------------------------------------------------------------
 * What an instructor can ask when listing THEIR cohorts:
 *   ?status=PLANNED | ACTIVE | CLOSED (leave out = current cohorts: PLANNED and ACTIVE),
 *   plus ?page= and ?pageSize=
 */
import { IsEnum, IsOptional } from 'class-validator';
import { CohortStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../common/pagination/pagination';

export class ListMyCohortsQuery extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(CohortStatus)
  status?: CohortStatus;
}