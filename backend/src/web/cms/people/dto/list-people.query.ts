/**
 * list-people.query.ts - ?kind=TEAM|INSTRUCTOR|BOTH&status=DRAFT|PUBLISHED&search=queen&page=1
 * In display order (the order on the website).
 */
import { CmsContentStatus, CmsPersonKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../../common/pagination/pagination';

export class ListPeopleQuery extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(CmsPersonKind)
  kind?: CmsPersonKind;

  @IsOptional()
  @IsEnum(CmsContentStatus)
  status?: CmsContentStatus;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;
}