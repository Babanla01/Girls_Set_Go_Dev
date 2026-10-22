/**
 * list-audit-logs.query.ts
 * ---------------------------------------------------------------------------
 * The filters an admin can put on the audit log:
 *   ?action=instructor.suspended&actorId=<uuid>&entityType=user&entityId=...
 *   &from=2026-10-01&to=2026-10-31&page=1&pageSize=50
 */
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../common/pagination/pagination';

export class ListAuditLogsQuery extends PaginationQueryDto {
  /** Exact action name, e.g. "auth.login_failed". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  /** Only entries made by this person. */
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  entityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  /** Earliest time (inclusive), e.g. 2026-10-01 or 2026-10-01T09:00:00Z. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /** Latest time (inclusive). */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}