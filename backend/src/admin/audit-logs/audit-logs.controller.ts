/**
 * audit-logs.controller.ts
 * ---------------------------------------------------------------------------
 * GET /api/v1/admin/audit-logs  - admin-only, read-only.
 * There are no POST/PATCH/DELETE routes: the audit log is a record, not a
 * to-do list.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../../auth/decorators/roles.decorator';
import { AuditLogsService } from './audit-logs.service';
import { ListAuditLogsQuery } from './dto/list-audit-logs.query';

@Roles(Role.ADMIN)
@Controller('admin/audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  list(@Query() query: ListAuditLogsQuery) {
    return this.auditLogs.list(query);
  }
}