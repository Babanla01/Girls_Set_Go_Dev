/**
 * list-announcements.query.ts - ?status=PUBLISHED&audienceType=COHORT&search=class&mine=true&page=1
 * Newest first. An instructor sees her own announcements and the published ones for her cohorts.
 */
import { AnnAudienceType, AnnStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../common/pagination/pagination';

export class ListAnnouncementsQuery extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(AnnStatus)
  status?: AnnStatus;

  @IsOptional()
  @IsEnum(AnnAudienceType)
  audienceType?: AnnAudienceType;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  /** true = only the ones I wrote. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  mine?: boolean;
}