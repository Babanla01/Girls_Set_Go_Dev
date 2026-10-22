/**
 * roles.guard.ts
 * ---------------------------------------------------------------------------
 * Runs after the AuthGuard. If a route says @Roles(...), the signed-in
 * person's role must be one of those, otherwise: 403 "forbidden".
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { Request } from 'express';

import type { AuthenticatedRequest } from '../auth.types';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedRoles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles on this route: any signed-in person may continue.
    if (!allowedRoles || allowedRoles.length === 0) return true;

    const user = (context.switchToHttp().getRequest<Request>() as AuthenticatedRequest).user;

    // No user here means the route is @Public but also asks for roles - a
    // mistake we resolve safely by refusing.
    if (!user || !allowedRoles.includes(user.role)) {
      throw new ForbiddenException('You do not have permission to do that.');
    }
    return true;
  }
}