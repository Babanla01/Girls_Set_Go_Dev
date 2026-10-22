/**
 * session.service.ts
 * ---------------------------------------------------------------------------
 * Creates, checks and ends login sessions.
 *
 * How a session works:
 *  1. At login we create a random token. The BROWSER gets it in a secure
 *     cookie (JavaScript cannot read it). The DATABASE stores only its hash.
 *  2. On every request we look the session up by that hash and re-check that
 *     the account is still ACTIVE - so suspending someone cuts them off
 *     immediately.
 *  3. A session ends when: the person logs out, a password reset revokes it,
 *     7 days pass with no activity, or 30 days pass in total.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus } from '@prisma/client';
import type { Request, Response } from 'express';

import type { DbClient } from '../common/types/db-client';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from './auth.constants';
import type { AuthenticatedUser, RequestContext } from './auth.types';
import { TokenService } from './token.service';

@Injectable()
export class SessionService {
  private readonly secureCookies: boolean;
  readonly cookieName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    config: ConfigService<Env, true>,
  ) {
    // In production the cookie is HTTPS-only and uses the strict "__Host-" name.
    this.secureCookies = config.get('NODE_ENV', { infer: true }) === 'production';
    this.cookieName = this.secureCookies ? SESSION_COOKIE_NAME_SECURE : SESSION_COOKIE_NAME;
  }

  /** Starts a session and returns the RAW token to put in the cookie. */
  async create(userId: string, context: RequestContext): Promise<string> {
    const token = this.tokens.generate();

    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: this.tokens.hash(token),
        expiresAt: new Date(Date.now() + SESSION_ABSOLUTE_MS),
        ipAddress: context.ipAddress?.slice(0, 45) ?? null,
        userAgent: context.userAgent,
      },
    });

    return token;
  }

  /**
   * Returns the signed-in user for a cookie token, or null if the session is
   * not (or no longer) valid. One indexed database lookup per request.
   */
  async validate(token: string): Promise<{ sessionId: string; user: AuthenticatedUser } | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.tokens.hash(token) },
      select: {
        id: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        user: { select: { id: true, email: true, fullName: true, role: true, status: true } },
      },
    });
    if (!session) return null;

    const now = Date.now();
    const expired = session.expiresAt.getTime() <= now;
    const idleTooLong = now - session.lastUsedAt.getTime() > SESSION_IDLE_MS;
    const accountActive = session.user.status === AccountStatus.ACTIVE;

    if (session.revokedAt || expired || idleTooLong || !accountActive) return null;

    // Record activity - but only every few minutes, not on every request.
    if (now - session.lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date(now) } });
    }

    const { id, email, fullName, role } = session.user;
    return { sessionId: session.id, user: { id, email, fullName, role } };
  }

  /** Ends one session (logout). */
  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Ends ALL of a user's sessions (used after a password reset). */
  async revokeAllForUser(userId: string, db: DbClient = this.prisma): Promise<void> {
    await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ----------------------------------------------------------------- cookies

  readCookie(req: Request): string | null {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[this.cookieName];
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
  }

  setCookie(res: Response, token: string): void {
    res.cookie(this.cookieName, token, {
      httpOnly: true, // JavaScript on the page can never read it
      secure: this.secureCookies, // HTTPS only in production
      sameSite: 'lax', // not sent on cross-site POSTs (CSRF protection)
      path: '/',
      maxAge: SESSION_ABSOLUTE_MS,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(this.cookieName, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
    });
  }
}