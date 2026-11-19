/**
 * list-videos.query.ts - ?category=AI_ROBOTICS&status=DRAFT&search=robot&captions=missing&page=1
 * (a video matches a category when it is filed under it OR tagged with it). Latest changes first.
 */
import { CmsContentStatus, CmsVideoCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../../common/pagination/pagination';

export class ListVideosQuery extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(CmsVideoCategory)
  category?: CmsVideoCategory;

  @IsOptional()
  @IsEnum(CmsContentStatus)
  status?: CmsContentStatus;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  /** "missing" = only videos that still have no captions. */
  @IsOptional()
  @IsIn(['missing'])
  captions?: 'missing';
}