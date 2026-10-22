/**
 * audit.service.ts
 * ---------------------------------------------------------------------------
 * Writes entries to the append-only audit log ("who did what, to what, when").
 *
 * Rules for callers:
 *  - Pass the transaction (`tx`) when the action happens inside one, so the
 *    audit entry commits or rolls back together with the action itself.
 *  - NEVER put passwords, tokens or reset links in `metadata`.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { DbClient } from '../types/db-client';

export interface AuditEntry {
  /** Who did it. Leave empty when the system or an anonymous visitor did. */
  actorId?: string | null;
  /** What happened, e.g. "auth.login". */
  action: string;
  /** What it happened to, e.g. "user". */
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, db: DbClient = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action.slice(0, 100),
        entityType: entry.entityType.slice(0, 50),
        entityId: entry.entityId?.slice(0, 64) ?? null,
        metadata: entry.metadata,
        ipAddress: entry.ipAddress?.slice(0, 45) ?? null,
      },
    });
  }
}