/**
 * signed-url.service.ts
 * ---------------------------------------------------------------------------
 * Short-lived links for PRIVATE files.
 *
 * A signed link is a token that says "this file may be opened until this
 * moment" and carries a signature only the server can make. It cannot be
 * edited (the signature would no longer match), it stops working after a few
 * minutes (10 by default), and it can be tied to one signed-in person so a
 * copied link is useless to anyone else.
 *
 * The code that creates a link is responsible for first checking that the
 * person may see the file (for example: is this student enrolled?). The link
 * route (private-files.controller.ts) then checks the signature, the expiry and
 * the person on every single request.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Env } from '../../config/env.validation';

export const SIGNED_URL_TTL_SECONDS = 10 * 60;

export interface SignedFileClaims {
  /** Storage key; must start with "private/". */
  key: string;
  contentType: string;
  /** The name the browser offers when saving. */
  filename?: string;
  /** If set, only this signed-in person can use the link. */
  userId?: string;
}

interface TokenPayload {
  k: string;
  t: string;
  n?: string;
  u?: string;
  e: number; // expiry, seconds since 1970
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

@Injectable()
export class SignedUrlService {
  private readonly secret: string;

  constructor(config: ConfigService<Env, true>) {
    // A separate secret when one is configured; otherwise derived from the session secret.
    this.secret =
      config.get('FILES_SIGNING_SECRET', { infer: true }) ??
      createHmac('sha256', config.get('SESSION_SECRET', { infer: true })).update('girls-set-go:files-signing:v1').digest('hex');
  }

  /** Makes a token for a private file. Put it in the URL "/api/v1/files/private/<token>". */
  sign(claims: SignedFileClaims, ttlSeconds: number = SIGNED_URL_TTL_SECONDS): string {
    const payload: TokenPayload = {
      k: claims.key,
      t: claims.contentType,
      ...(claims.filename ? { n: claims.filename } : {}),
      ...(claims.userId ? { u: claims.userId } : {}),
      e: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
    const body = base64url(JSON.stringify(payload));
    return `${body}.${this.signature(body)}`;
  }

  /** The claims inside a token, or null when it is forged, damaged or expired. */
  verify(token: string): SignedFileClaims | null {
    const [body, signature, ...extra] = token.split('.');
    if (!body || !signature || extra.length > 0) return null;

    const expected = Buffer.from(this.signature(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    } catch {
      return null;
    }

    if (typeof payload.k !== 'string' || typeof payload.t !== 'string' || typeof payload.e !== 'number') return null;
    if (payload.e < Math.floor(Date.now() / 1000)) return null;

    return { key: payload.k, contentType: payload.t, filename: payload.n, userId: payload.u };
  }

  private signature(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}