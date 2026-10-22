/**
 * instructors.service.ts
 * ---------------------------------------------------------------------------
 * The rules for how admins manage instructor accounts.
 *
 * Principles used throughout:
 *  - EVERYTHING THAT BELONGS TOGETHER HAPPENS TOGETHER. Creating an
 *    instructor = save the user + make the invite link + queue the email +
 *    write the audit entry, all in ONE transaction. If any step fails, none of
 *    them happen.
 *  - NOBODY IS DELETED. Instructors are suspended, so their history survives.
 *  - SUSPENDING IS INSTANT. It switches the status and ends every session in
 *    the same transaction.
 *  - These routes can only ever touch INSTRUCTORS: an admin's or student's id
 *    is simply "not found" here.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, AuthTokenType, Prisma, Role } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { OutboxEmail, OutboxService } from '../../common/outbox/outbox.service';
import { buildPage, Paginated, toSkipTake } from '../../common/pagination/pagination';
import type { DbClient } from '../../common/types/db-client';
import { normalizeEmail } from '../../common/utils/normalize-email';
import { INVITE_LINK_TTL_MS } from '../../auth/auth.constants';
import { AuthService } from '../../auth/auth.service';
import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { SessionService } from '../../auth/session.service';
import { TokenService } from '../../auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateInstructorDto } from './dto/create-instructor.dto';
import type { ListInstructorsQuery } from './dto/list-instructors.query';
import type { SuspendInstructorDto } from './dto/suspend-instructor.dto';
import type { UpdateInstructorDto } from './dto/update-instructor.dto';
import {
  InstructorSummary,
  instructorSelect,
  InviteState,
  toInstructorSummary,
} from './instructor.view';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instructor columns we load for changes, plus whether a password exists (never returned). */
const workingSelect = { ...instructorSelect, passwordHash: true } satisfies Prisma.UserSelect;
type WorkingRow = Prisma.UserGetPayload<{ select: typeof workingSelect }>;

@Injectable()
export class InstructorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ------------------------------------------------------------------ create

  async create(
    admin: AuthenticatedUser,
    dto: CreateInstructorDto,
    context: RequestContext,
  ): Promise<{ instructor: InstructorSummary }> {
    const email = normalizeEmail(dto.email);
    const fullName = dto.fullName.trim();

    try {
      const { row, message } = await this.prisma.$transaction(async (tx) => {
        const row = await tx.user.create({
          data: {
            email,
            fullName,
            role: Role.INSTRUCTOR,
            status: AccountStatus.INVITED,
            createdById: admin.id,
          },
          select: instructorSelect,
        });

        const message = await this.queueInvite(tx, row, admin);

        await this.audit.record(
          {
            actorId: admin.id,
            action: 'instructor.created',
            entityType: 'user',
            entityId: row.id,
            metadata: { email },
            ipAddress: context.ipAddress,
          },
          tx,
        );

        return { row, message };
      });

      this.outbox.previewInDevelopment(message);
      return { instructor: toInstructorSummary(row) };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  // -------------------------------------------------------------------- list

  async list(query: ListInstructorsQuery): Promise<Paginated<InstructorSummary>> {
    const where: Prisma.UserWhereInput = {
      role: Role.INSTRUCTOR,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search.toLowerCase() } },
            ],
          }
        : {}),
    };

    // Newest sign-ins first sorts people who never signed in last, not first.
    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      query.sortBy === 'lastLoginAt'
        ? [{ lastLoginAt: { sort: query.sortDir, nulls: 'last' } }, { id: 'asc' }]
        : [{ [query.sortBy]: query.sortDir }, { id: 'asc' }]; // "id" keeps paging stable when values tie

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, orderBy, ...toSkipTake(query), select: instructorSelect }),
    ]);

    return buildPage(rows.map(toInstructorSummary), total, query);
  }

  // ------------------------------------------------------------------ detail

  async getOne(id: string) {
    const row = await this.prisma.user.findFirst({
      where: { id, role: Role.INSTRUCTOR },
      select: {
        ...workingSelect,
        createdBy: { select: { id: true, fullName: true } },
      },
    });
    if (!row) throw new NotFoundException('Instructor not found.');

    return {
      instructor: { ...toInstructorSummary(row), createdBy: row.createdBy },
      invite: await this.inviteStateFor(row),
    };
  }

  /** accepted = they have set a password; pending = a usable link exists; expired = they need a new link. */
  private async inviteStateFor(row: Pick<WorkingRow, 'id' | 'passwordHash'>): Promise<{
    state: InviteState;
    expiresAt: Date | null;
  }> {
    if (row.passwordHash) return { state: 'accepted', expiresAt: null };

    const latest = await this.prisma.authToken.findFirst({
      where: { userId: row.id, type: AuthTokenType.INVITE },
      orderBy: { createdAt: 'desc' },
      select: { usedAt: true, expiresAt: true },
    });

    if (latest && !latest.usedAt && latest.expiresAt > new Date()) {
      return { state: 'pending', expiresAt: latest.expiresAt };
    }
    return { state: 'expired', expiresAt: null };
  }

  // ------------------------------------------------------------------ update

  async update(
    admin: AuthenticatedUser,
    id: string,
    dto: UpdateInstructorDto,
    context: RequestContext,
  ): Promise<{ instructor: InstructorSummary }> {
    if (dto.fullName === undefined && dto.email === undefined) {
      throw new BadRequestException('Nothing to update. Provide a name or an email.');
    }

    try {
      const { row, message } = await this.prisma.$transaction(async (tx) => {
        const current = await this.findOrThrow(tx, id);

        const data: Prisma.UserUpdateInput = {};
        const changed: string[] = [];
        let newEmail: string | undefined;

        if (dto.fullName !== undefined && dto.fullName.trim() !== current.fullName) {
          data.fullName = dto.fullName.trim();
          changed.push('fullName');
        }

        if (dto.email !== undefined && normalizeEmail(dto.email) !== current.email) {
          // After sign-up the email IS their sign-in identity; changing it safely needs verification.
          if (current.status !== AccountStatus.INVITED) {
            throw new BadRequestException('The email can only be changed while the invitation is still pending.');
          }
          newEmail = normalizeEmail(dto.email);
          data.email = newEmail;
          changed.push('email');
        }

        if (changed.length === 0) return { row: current, message: null }; // nothing really changed

        const updated = await tx.user.update({ where: { id }, data, select: instructorSelect });

        // A new email means the OLD invite link (sent to the old address) must stop
        // working, and a fresh one goes to the new address.
        const message = newEmail ? await this.queueInvite(tx, updated, admin) : null;

        await this.audit.record(
          {
            actorId: admin.id,
            action: newEmail ? 'instructor.email_changed' : 'instructor.updated',
            entityType: 'user',
            entityId: id,
            metadata: newEmail
              ? { changed, previousEmail: current.email, newEmail }
              : { changed },
            ipAddress: context.ipAddress,
          },
          tx,
        );

        return { row: updated, message };
      });

      if (message) this.outbox.previewInDevelopment(message);
      return { instructor: toInstructorSummary(row) };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  // ------------------------------------------------------------ resend invite

  async resendInvite(
    admin: AuthenticatedUser,
    id: string,
    context: RequestContext,
  ): Promise<{ instructor: InstructorSummary }> {
    const { row, message } = await this.prisma.$transaction(async (tx) => {
      const current = await this.findOrThrow(tx, id);

      if (current.status !== AccountStatus.INVITED) {
        throw new ConflictException('Only pending invitations can be resent.');
      }

      const message = await this.queueInvite(tx, current, admin); // voids the old link
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'instructor.invite_resent',
          entityType: 'user',
          entityId: id,
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { row: current, message };
    });

    this.outbox.previewInDevelopment(message);
    return { instructor: toInstructorSummary(row) };
  }

  // ------------------------------------------------------ suspend / reactivate

  async suspend(
    admin: AuthenticatedUser,
    id: string,
    dto: SuspendInstructorDto,
    context: RequestContext,
  ): Promise<{ instructor: InstructorSummary }> {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await this.findOrThrow(tx, id);

      if (current.status === AccountStatus.SUSPENDED) {
        throw new ConflictException('This instructor is already suspended.');
      }

      const updated = await tx.user.update({
        where: { id },
        data: { status: AccountStatus.SUSPENDED },
        select: instructorSelect,
      });

      // Sign them out of every device RIGHT NOW (in the same transaction).
      await this.sessions.revokeAllForUser(id, tx);

      await this.audit.record(
        {
          actorId: admin.id,
          action: 'instructor.suspended',
          entityType: 'user',
          entityId: id,
          metadata: dto.reason ? { reason: dto.reason } : {},
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return updated;
    });

    return { instructor: toInstructorSummary(row) };
  }

  async reactivate(
    admin: AuthenticatedUser,
    id: string,
    context: RequestContext,
  ): Promise<{ instructor: InstructorSummary }> {
    const { row, message } = await this.prisma.$transaction(async (tx) => {
      const current = await this.findOrThrow(tx, id);

      if (current.status !== AccountStatus.SUSPENDED) {
        throw new ConflictException('Only suspended instructors can be reactivated.');
      }

      // Someone who already set a password goes straight back to ACTIVE.
      // Someone who never did goes back to INVITED and gets a fresh link.
      const restoredStatus = current.passwordHash ? AccountStatus.ACTIVE : AccountStatus.INVITED;

      const updated = await tx.user.update({
        where: { id },
        data: { status: restoredStatus },
        select: instructorSelect,
      });
      const message = restoredStatus === AccountStatus.INVITED ? await this.queueInvite(tx, updated, admin) : null;

      await this.audit.record(
        {
          actorId: admin.id,
          action: 'instructor.reactivated',
          entityType: 'user',
          entityId: id,
          metadata: { restoredStatus },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { row: updated, message };
    });

    if (message) this.outbox.previewInDevelopment(message);
    return { instructor: toInstructorSummary(row) };
  }

  // ----------------------------------------------------------------- helpers

  /** Loads an instructor, or throws "not found" (also for ids of admins and students). */
  private async findOrThrow(db: DbClient, id: string): Promise<WorkingRow> {
    const row = await db.user.findFirst({
      where: { id, role: Role.INSTRUCTOR },
      select: workingSelect,
    });
    if (!row) throw new NotFoundException('Instructor not found.');
    return row;
  }

  /** Makes a fresh invite link (voiding any older one) and queues the email. Runs inside a transaction. */
  private async queueInvite(
    db: DbClient,
    user: { id: string; email: string; fullName: string },
    admin: AuthenticatedUser,
  ): Promise<OutboxEmail> {
    const token = await this.tokens.issue(user.id, AuthTokenType.INVITE, db);

    const message: OutboxEmail = {
      toEmail: user.email,
      template: 'instructor-invite',
      payload: {
        fullName: user.fullName,
        actionUrl: this.auth.buildLink('set-password', token),
        invitedBy: admin.fullName,
        expiresInDays: INVITE_LINK_TTL_MS / DAY_MS,
      },
    };
    await this.outbox.enqueue(message, db);
    return message;
  }

  /** Turns "that email is taken" (a database rule) into a friendly 409. Other errors pass through. */
  private translateDatabaseError(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException('An account with that email already exists.');
    }
    return error;
  }
}