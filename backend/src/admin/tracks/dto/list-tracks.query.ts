/**
 * list-tracks.query.ts
 * ---------------------------------------------------------------------------
 *   ?page=1&pageSize=20&search=robot&status=ACTIVE&sortBy=name&sortDir=asc
 */
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { TrackStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination';

export const TRACK_SORT_FIELDS = ['name', 'createdAt'] as const;

export class ListTracksQuery extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(TrackStatus)
  status?: TrackStatus;

  @IsOptional()
  @IsIn(TRACK_SORT_FIELDS)
  sortBy: (typeof TRACK_SORT_FIELDS)[number] = 'name';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'asc';
}