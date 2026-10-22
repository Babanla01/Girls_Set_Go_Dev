/**
 * audit-logs.service.ts
 * ---------------------------------------------------------------------------
 * READ-ONLY access to the audit log for admins. There is intentionally no
 * method here that changes or deletes entries (and the database itself refuses
 * such changes - see the append-only trigger from Batch 2).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { buildPage, Paginated, toSkipTake } from '../../common/pagination/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import type { ListAuditLogsQuery } from './dto/list-audit-logs.query';

export interface AuditLogView {
  id: string;
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Prisma.JsonValue | null;
  ipAddress: string | null;
  actor: { id: string; fullName: string; email: string } | null;
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAuditLogsQuery): Promise<Paginated<AuditLogView>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        // Newest first; "id" keeps the order stable when two entries share a timestamp.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...toSkipTake(query),
        select: {
          id: true,
          createdAt: true,
          action: true,
          entityType: true,
          entityId: true,
          metadata: true,
          ipAddress: true,
          actor: { select: { id: true, fullName: true, email: true } },
        },
      }),
    ]);

    return buildPage(rows, total, query);
  }
}