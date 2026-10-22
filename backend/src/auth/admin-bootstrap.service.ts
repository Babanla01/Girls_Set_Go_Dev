/**
 * admin-bootstrap.service.ts
 * ---------------------------------------------------------------------------
 * Creates an ADMIN account from the server's command line (never from the
 * website). Used to create the very first admin.
 *
 * It creates the account in the INVITED state and returns a one-time
 * set-password link, so nobody ever types a password into a terminal (where it
 * would be saved in shell history). Only someone with access to the server can
 * run it - there is no public way to create an admin.
 */
import { Injectable } from '@nestjs/common';
import { AccountStatus, AuthTokenType, Role } from '@prisma/client';
import { isEmail } from 'class-validator';

import { AuditService } from '../common/audit/audit.service';
import { normalizeEmail } from '../common/utils/normalize-email';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

@Injectable()
export class AdminBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async createAdminInvite(input: { email: string; fullName: string }): Promise<{ link: string }> {
    const email = normalizeEmail(input.email);
    const fullName = input.fullName.trim();

    if (!isEmail(email) || email.length > 254) throw new Error('Please provide a valid email address.');
    if (fullName.length < 2 || fullName.length > 120) throw new Error('The name must be 2 to 120 characters.');

    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new Error('An account with that email already exists.');

    const token = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, fullName, role: Role.ADMIN, status: AccountStatus.INVITED },
      });
      const inviteToken = await this.tokens.issue(user.id, AuthTokenType.INVITE, tx);
      await this.audit.record(
        { action: 'admin.created_via_command_line', entityType: 'user', entityId: user.id },
        tx,
      );
      return inviteToken;
    });

    return { link: this.auth.buildLink('set-password', token) };
  }
}