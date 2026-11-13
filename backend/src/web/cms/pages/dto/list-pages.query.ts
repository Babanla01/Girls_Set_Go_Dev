/**
 * list-pages.query.ts - ?search=about&status=PUBLISHED&page=1&pageSize=20
 * (status DRAFT = not live, PUBLISHED = live). Most recently changed first.
 */
import { CmsContentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../../common/pagination/pagination';

export class ListPagesQuery extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(CmsContentStatus)
  status?: CmsContentStatus;
}