/**
 * audit.service.ts
 * ---------------------------------------------------------------------------
 * Writes entries to the append-only audit log ("who did what, to what, when").
 *
 * Every entry records:
 *   - WHO did it, and the ROLE they had at that moment (filled in automatically
 *     from the actor id, so callers do not have to remember it);
 *   - WHAT happened and to which thing;
 *   - optionally the PREVIOUS and NEW value of what changed.
 *
 * Rules for callers:
 *  - Pass the transaction (`tx`) when the action happens inside one, so the
 *    audit entry commits or rolls back together with the action itself.
 *  - NEVER put passwords, tokens or reset links in any field.
 *  - previousValue / newValue are for SMALL facts such as a status, a cohort id
 *    or a setting - never personal details (names, emails, phones, birth dates)
 *    and never free-text the person typed.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { DbClient } from '../types/db-client';

export interface AuditEntry {
  /** Who did it. Leave empty when the system or an anonymous visitor did. */
  actorId?: string | null;
  /**
   * The actor's role. Optional: when you leave it out, it is looked up from
   * `actorId` (one quick lookup by id). Pass it when you already know it, to skip that lookup.
   */
  actorRole?: Role | null;
  /** What happened, e.g. "auth.login". */
  action: string;
  /** What it happened to, e.g. "user". */
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  /** How the thing looked BEFORE the change, e.g. { status: 'PENDING' }. */
  previousValue?: Prisma.InputJsonValue;
  /** How the thing looks AFTER the change, e.g. { status: 'ACCEPTED', cohortId: '...' }. */
  newValue?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, db: DbClient = this.prisma): Promise<void> {
    const actorRole = await this.resolveRole(entry, db);

    await db.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorRole,
        action: entry.action.slice(0, 100),
        entityType: entry.entityType.slice(0, 50),
        entityId: entry.entityId?.slice(0, 64) ?? null,
        metadata: entry.metadata,
        previousValue: entry.previousValue,
        newValue: entry.newValue,
        ipAddress: entry.ipAddress?.slice(0, 45) ?? null,
      },
    });
  }

  /** The role given by the caller, else the actor's current role, else none (system / visitor). */
  private async resolveRole(entry: AuditEntry, db: DbClient): Promise<Role | null> {
    if (entry.actorRole !== undefined) return entry.actorRole;
    if (!entry.actorId) return null;

    const actor = await db.user.findUnique({ where: { id: entry.actorId }, select: { role: true } });
    return actor?.role ?? null;
  }
}