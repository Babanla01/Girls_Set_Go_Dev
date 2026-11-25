/**
 * list-banners.query.ts - ?placement=HOME
 * With a page: the slides of that page in their order. Without: every slide, newest first.
 */
import { CmsBannerPage } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class ListBannersQuery {
  @IsOptional()
  @IsEnum(CmsBannerPage)
  placement?: CmsBannerPage;
}