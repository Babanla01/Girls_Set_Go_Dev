/**
 * current-user.decorator.ts
 * ---------------------------------------------------------------------------
 * @CurrentUser() gives a route handler the signed-in person:
 *
 *    me(@CurrentUser() user: AuthenticatedUser) { ... }
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest, AuthenticatedUser } from '../auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    return context.switchToHttp().getRequest<AuthenticatedRequest>().user;
  },
);