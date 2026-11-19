/**
 * reorder-videos.dto.ts
 *   POST /api/v1/admin/videos/reorder   { "category": "AI_ROBOTICS", "ids": ["<first>", "<second>", ...] }
 * Puts the videos filed under that category in this order (the first id is shown first).
 */
import { CmsVideoCategory } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsUUID } from 'class-validator';

export class ReorderVideosDto {
  @IsEnum(CmsVideoCategory)
  category!: CmsVideoCategory;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}