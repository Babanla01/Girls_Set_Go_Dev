/**
 * auth.service.ts
 * ---------------------------------------------------------------------------
 * The business rules for signing in, signing out, forgotten passwords and
 * accepting invitations.
 *
 * Security principles used throughout:
 *  - FAILED LOGINS ALL LOOK THE SAME: wrong password, unknown email, wrong
 *    login door, invited or suspended account -> the identical error.
 *  - "FORGOT PASSWORD" ALWAYS ANSWERS THE SAME and takes the same time, so it
 *    cannot be used to discover which emails are registered.
 *  - Changes that must happen together (use up the link + set the password +
 *    end old sessions + write the audit entry) run in ONE transaction.
 */
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, AuthTokenType } from '@prisma/client';

import { AuditService } from '../common/audit/audit.service';
import { OutboxService } from '../common/outbox/outbox.service';
import { normalizeEmail } from '../common/utils/normalize-email';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import {
  GENERIC_LOGIN_ERROR,
  INVALID_LINK_ERROR,
  PORTAL_ROLES,
  RESET_LINK_TTL_MS,
  RESET_MIN_RESPONSE_MS,
} from './auth.constants';
import type { AuthenticatedUser, RequestContext } from './auth.types';
import type { LoginDto } from './dto/login.dto';
import { LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password/password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly loginAttempts: LoginAttemptService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ------------------------------------------------------------------ login

  async login(
    dto: LoginDto,
    context: RequestContext,
  ): Promise<{ user: AuthenticatedUser; sessionToken: string }> {
    const email = normalizeEmail(dto.email);

    // 1) Paused after too many wrong passwords? Say so without looking anyone up.
    if (await this.loginAttempts.isBlocked(email)) {
      await this.audit.record({
        action: 'auth.login_blocked',
        entityType: 'user',
        metadata: { email, portal: dto.portal },
        ipAddress: context.ipAddress,
      });
      throw new HttpException(
        'Too many failed attempts. Please wait 15 minutes and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 2) Always do the full password check (even for unknown emails) so every
    //    failure takes about the same time.
    const user = await this.prisma.user.findUnique({ where: { email } });
    const passwordOk = await this.passwords.verify(user?.passwordHash ?? null, dto.password);
    const roleMatches = user?.role === PORTAL_ROLES[dto.portal];
    const accountActive = user?.status === AccountStatus.ACTIVE;

    if (!user || !passwordOk || !roleMatches || !accountActive) {
      // The REASON is recorded privately for admins; the visitor sees only the generic error.
      const reason = !user
        ? 'unknown_email'
        : !passwordOk
          ? 'bad_password'
          : !accountActive
            ? `account_${user.status.toLowerCase()}`
            : 'wrong_portal';

      await this.loginAttempts.recordFailure(email);
      await this.audit.record({
        actorId: user?.id ?? null,
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user?.id ?? null,
        metadata: { email, portal: dto.portal, reason },
        ipAddress: context.ipAddress,
      });
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }

    // 3) Success.
    await this.loginAttempts.reset(email);
    const sessionToken = await this.sessions.create(user.id, context);

    // Quietly upgrade the stored hash if our hashing settings have improved.
    const upgradedHash =
      user.passwordHash && this.passwords.needsRehash(user.passwordHash)
        ? await this.passwords.hash(dto.password)
        : undefined;

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), ...(upgradedHash ? { passwordHash: upgradedHash } : {}) },
    });

    await this.audit.record({
      actorId: user.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      metadata: { portal: dto.portal },
      ipAddress: context.ipAddress,
    });

    return {
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
      sessionToken,
    };
  }

  async logout(user: AuthenticatedUser, sessionId: string, context: RequestContext): Promise<void> {
    await this.sessions.revoke(sessionId);
    await this.audit.record({
      actorId: user.id,
      action: 'auth.logout',
      entityType: 'user',
      entityId: user.id,
      ipAddress: context.ipAddress,
    });
  }

  // -------------------------------------------------------- forgot password

  /**
   * Always resolves normally and takes at least RESET_MIN_RESPONSE_MS, whether
   * or not the email belongs to an account. Internal failures are logged but
   * never shown (they could reveal whether the account exists).
   */
  async requestPasswordReset(emailInput: string, context: RequestContext): Promise<void> {
    const startedAt = Date.now();

    try {
      await this.createResetLinkIfAccountExists(normalizeEmail(emailInput), context);
    } catch (error) {
      this.logger.error(`Password reset request failed: ${(error as Error).message}`);
    }

    await sleep(Math.max(0, RESET_MIN_RESPONSE_MS - (Date.now() - startedAt)));
  }

  private async createResetLinkIfAccountExists(email: string, context: RequestContext): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, fullName: true, status: true },
    });

    // Only ACTIVE accounts can reset (invited users use their invite link).
    if (!user || user.status !== AccountStatus.ACTIVE) {
      await this.audit.record({
        action: 'auth.password_reset_requested',
        entityType: 'user',
        metadata: { matched: false },
        ipAddress: context.ipAddress,
      });
      return;
    }

    const queuedEmail = await this.prisma.$transaction(async (tx) => {
      const token = await this.tokens.issue(user.id, AuthTokenType.PASSWORD_RESET, tx);
      const message = {
        toEmail: user.email,
        template: 'password-reset',
        payload: {
          fullName: user.fullName,
          actionUrl: this.buildLink('reset-password', token),
          expiresInMinutes: RESET_LINK_TTL_MS / 60_000,
        },
      };
      await this.outbox.enqueue(message, tx);
      await this.audit.record(
        {
          actorId: user.id,
          action: 'auth.password_reset_requested',
          entityType: 'user',
          entityId: user.id,
          metadata: { matched: true },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return message;
    });

    this.outbox.previewInDevelopment(queuedEmail);
  }

  // --------------------------------------------------------- reset / invite

  /** Uses a reset link to choose a new password. Signs the user out everywhere. */
  async resetPassword(token: string, newPassword: string, context: RequestContext): Promise<void> {
    const hash = await this.hashAfterPolicyCheck(newPassword);

    const email = await this.prisma.$transaction(async (tx) => {
      const userId = await this.tokens.claim(token, AuthTokenType.PASSWORD_RESET, tx);
      if (!userId) throw new BadRequestException(INVALID_LINK_ERROR);

      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, status: true } });
      if (!user || user.status !== AccountStatus.ACTIVE) throw new BadRequestException(INVALID_LINK_ERROR);

      await tx.user.update({ where: { id: userId }, data: { passwordHash: hash } });
      await this.sessions.revokeAllForUser(userId, tx); // sign out everywhere
      await this.audit.record(
        {
          actorId: userId,
          action: 'auth.password_reset_completed',
          entityType: 'user',
          entityId: userId,
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return user.email;
    });

    await this.loginAttempts.reset(email);
  }

  /** Uses an invite link: the invited person chooses their first password. */
  async acceptInvite(token: string, newPassword: string, context: RequestContext): Promise<void> {
    const hash = await this.hashAfterPolicyCheck(newPassword);

    await this.prisma.$transaction(async (tx) => {
      const userId = await this.tokens.claim(token, AuthTokenType.INVITE, tx);
      if (!userId) throw new BadRequestException(INVALID_LINK_ERROR);

      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
      if (!user || user.status !== AccountStatus.INVITED) throw new BadRequestException(INVALID_LINK_ERROR);

      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: hash, status: AccountStatus.ACTIVE },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'auth.invite_accepted',
          entityType: 'user',
          entityId: userId,
          ipAddress: context.ipAddress,
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------- helpers

  /** Checks the password rules (clear list of problems), then hashes it. */
  private async hashAfterPolicyCheck(password: string): Promise<string> {
    const problems = this.passwords.validatePolicy(password);
    if (problems.length > 0) throw new BadRequestException(problems);
    return this.passwords.hash(password);
  }

  /** Builds a link into the website, e.g. https://learn.example.org/reset-password?token=... */
  buildLink(page: 'reset-password' | 'set-password', token: string): string {
    const base = this.config.get('APP_URL', { infer: true }).replace(/\/+$/, '');
    return `${base}/${page}?token=${token}`;
  }
}