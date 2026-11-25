/**
 * public-banners.query.ts - GET /api/v1/public/banners?placement=HOME
 */
import { CmsBannerPage } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class PublicBannersQuery {
  @IsEnum(CmsBannerPage)
  placement!: CmsBannerPage;
}