/**
 * reorder-banners.dto.ts
 *   POST /api/v1/admin/banners/reorder   { "placement": "HOME", "ids": ["<first slide>", "<second slide>", ...] }
 * Puts the slides of that page in this order. Send every slide shown on the page.
 */
import { CmsBannerPage } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsUUID } from 'class-validator';

export class ReorderBannersDto {
  @IsEnum(CmsBannerPage)
  placement!: CmsBannerPage;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}