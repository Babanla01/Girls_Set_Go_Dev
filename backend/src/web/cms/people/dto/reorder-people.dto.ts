/**
 * reorder-people.dto.ts
 *   POST /api/v1/admin/people/reorder   { "ids": ["<id of first>", "<id of second>", ...] }
 * Send ALL the profiles shown together (for example everyone on the About page)
 * in the order they should appear.
 */
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class ReorderPeopleDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}