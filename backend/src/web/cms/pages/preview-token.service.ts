/**
 * preview-token.service.ts
 * ---------------------------------------------------------------------------
 * Short-lived "preview" links for a page's DRAFT.
 *
 * The public website cannot read a draft (visitors must never see one). So an
 * admin asks for a preview link: a signed token that is valid for 30 minutes and
 * is tied to ONE page. The website's preview screen hands the token to
 *     GET /api/v1/public/page-preview/<token>
 * which returns the draft exactly as it would look when published.
 *
 * The token cannot be edited (its signature would no longer match) and it only
 * opens the page it was made for.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Env } from '../../../config/env.validation';

export const PREVIEW_TTL_SECONDS = 30 * 60;

interface Payload {
  p: string; // page id
  e: number; // expiry, seconds since 1970
}

@Injectable()
export class PreviewTokenService {
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const configured = config.get('FILES_SIGNING_SECRET', { infer: true }) as string | undefined;
    const base: string = configured ?? (config.get('SESSION_SECRET', { infer: true }) as string);
    // A separate key for this one job, so a preview token can never be used for anything else.
    this.key = createHmac('sha256', base).update('girls-set-go:page-preview:v1').digest();
  }

  create(pageId: string): { token: string; expiresAt: Date } {
    const expires = Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS;
    const body = Buffer.from(JSON.stringify({ p: pageId, e: expires } satisfies Payload)).toString('base64url');
    return { token: `${body}.${this.sign(body)}`, expiresAt: new Date(expires * 1000) };
  }

  /** The page id inside a genuine, unexpired token; null otherwise. */
  verify(token: string): string | null {
    const [body, signature, ...extra] = token.split('.');
    if (!body || !signature || extra.length > 0) return null;

    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
      if (typeof payload.p !== 'string' || typeof payload.e !== 'number') return null;
      return payload.e < Math.floor(Date.now() / 1000) ? null : payload.p;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}