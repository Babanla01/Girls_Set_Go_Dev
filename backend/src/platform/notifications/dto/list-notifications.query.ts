/**
 * list-notifications.query.ts - ?unread=true&page=1&pageSize=20
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/pagination/pagination';

export class ListNotificationsQuery extends PaginationQueryDto {
  /** true = only notifications I have not read yet. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  unread?: boolean;
}