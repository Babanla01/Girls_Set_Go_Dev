/**
 * list-media.query.ts
 * ---------------------------------------------------------------------------
 *   ?folder=PEOPLE&search=queen&page=1&pageSize=24
 * Newest pictures first.
 */
import { CmsMediaFolder } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../../common/pagination/pagination';

export class ListMediaQuery extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(CmsMediaFolder)
  folder?: CmsMediaFolder;

  /** Matches part of the title or the key, ignoring capitals. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;
}