/**
 * auth.guard.ts
 * ---------------------------------------------------------------------------
 * The front door. Runs on EVERY route:
 *   - route marked @Public()  -> let anyone in
 *   - otherwise               -> require a valid session cookie
 *
 * "Deny by default": a route is locked unless someone deliberately opens it.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import type { AuthenticatedRequest } from '../auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SessionService } from '../session.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const token = this.sessions.readCookie(req);
    if (!token) {
      throw new UnauthorizedException('Please sign in to continue.');
    }

    const found = await this.sessions.validate(token);
    if (!found) {
      // Stale, revoked or suspended: remove the useless cookie from the browser.
      this.sessions.clearCookie(res);
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }

    const authed = req as AuthenticatedRequest;
    authed.user = found.user;
    authed.sessionId = found.sessionId;
    return true;
  }
}