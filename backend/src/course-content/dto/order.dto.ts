/**
 * order.dto.ts - a new order for a list: every id, exactly once, in the new order.
 */
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class OrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  orderedIds!: string[];
}
