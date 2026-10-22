/**
 * origin.guard.ts
 * ---------------------------------------------------------------------------
 * Protection against "cross-site request forgery" (CSRF): a malicious website
 * tricking a signed-in person's browser into sending a request to our API.
 *
 * How: any request that CHANGES data (POST, PUT, PATCH, DELETE) must come from
 * our own website. Browsers always say where a request came from in the
 * "Origin" header (or "Referer"); if it names a different site, we refuse.
 * This works together with the session cookie's SameSite=Lax setting.
 *
 * Requests with neither header (curl, server-to-server tools) are allowed:
 * they are not browser-driven, so CSRF does not apply to them.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { Env } from '../../config/env.validation';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function toOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null; // "null" and other garbage never match
  }
}

@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowedOrigins: Set<string>;

  constructor(config: ConfigService<Env, true>) {
    const candidates = [
      config.get('APP_URL', { infer: true }),
      ...config.get('CORS_ORIGINS', { infer: true }),
    ];
    this.allowedOrigins = new Set(
      candidates.map(toOrigin).filter((origin): origin is string => origin !== null),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = req.headers.origin;
    const referer = req.headers.referer;

    // Prefer Origin; fall back to the origin part of Referer.
    const claimed =
      typeof origin === 'string' ? toOrigin(origin) ?? '' : typeof referer === 'string' ? toOrigin(referer) ?? '' : null;

    if (claimed === null) return true; // neither header: not a browser request
    if (this.allowedOrigins.has(claimed)) return true;

    throw new ForbiddenException('This request did not come from our website.');
  }
}