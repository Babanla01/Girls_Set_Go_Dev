/**
 * public-videos.query.ts
 *   GET /api/v1/public/videos?category=ai-robotics&showOn=studio&featured=true&page=1&pageSize=12
 *   category   a category address word: ui-ux-projects | ai-robotics | student-stories | behind-the-scenes
 *   showOn     home | studio | showcase   (which part of the website the videos are for)
 *   featured   true = only featured videos
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../../common/pagination/pagination';

export class PublicVideosQuery extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @IsOptional()
  @IsIn(['home', 'studio', 'showcase'])
  showOn?: 'home' | 'studio' | 'showcase';

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  featured?: boolean;
}