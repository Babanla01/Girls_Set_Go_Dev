/**
 * token.service.ts
 * ---------------------------------------------------------------------------
 * Creates and checks the random secrets behind sessions and one-time links
 * (invites, password resets and email confirmations).
 *
 * Plain-English notes:
 *  - A token is 32 random bytes. The database stores only a keyed hash
 *    (HMAC-SHA256 using SESSION_SECRET), never the token itself. So a database
 *    leak alone cannot sign anyone in or reset anyone's password.
 *    (Side effect: changing SESSION_SECRET signs everyone out and voids all
 *    unused links - handy in an emergency.)
 *  - One-time links are USED UP in a single atomic database step, so two
 *    people (or one double-click) can never both use the same link.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthTokenType } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';

import type { DbClient } from '../common/types/db-client';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { INVITE_LINK_TTL_MS, RESET_LINK_TTL_MS, VERIFY_LINK_TTL_MS } from './auth.constants';

@Injectable()
export class TokenService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('SESSION_SECRET', { infer: true });
  }

  /** A fresh unguessable secret (URL-safe text). */
  generate(): string {
    return randomBytes(32).toString('base64url');
  }

  /** The value stored in the database for a token (64 hex characters). */
  hash(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('hex');
  }

  /**
   * Creates a one-time link token for a user and returns the RAW token
   * (to be put in the emailed link - it is never stored).
   * Any older unused token of the same type for this user is voided first,
   * so only the newest link ever works.
   */
  async issue(userId: string, type: AuthTokenType, db: DbClient = this.prisma): Promise<string> {
    const now = new Date();
    await db.authToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: now },
    });

    const token = this.generate();
    const ttl =
      type === AuthTokenType.INVITE
        ? INVITE_LINK_TTL_MS
        : type === AuthTokenType.EMAIL_VERIFICATION
          ? VERIFY_LINK_TTL_MS
          : RESET_LINK_TTL_MS;

    await db.authToken.create({
      data: {
        userId,
        type,
        tokenHash: this.hash(token),
        expiresAt: new Date(now.getTime() + ttl),
      },
    });

    return token;
  }

  /**
   * Uses up a token in ONE atomic step. Returns the user it belongs to, or
   * null if the token is unknown, expired, already used, or the wrong type.
   */
  async claim(token: string, type: AuthTokenType, db: DbClient = this.prisma): Promise<string | null> {
    const tokenHash = this.hash(token);

    const result = await db.authToken.updateMany({
      where: { tokenHash, type, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (result.count !== 1) return null;

    const row = await db.authToken.findUnique({ where: { tokenHash }, select: { userId: true } });
    return row?.userId ?? null;
  }
}