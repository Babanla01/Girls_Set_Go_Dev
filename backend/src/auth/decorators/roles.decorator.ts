/**
 * roles.decorator.ts
 * ---------------------------------------------------------------------------
 * @Roles(Role.ADMIN) limits a route to the listed roles.
 * A route with no @Roles still requires sign-in, but accepts any role.
 */
import { SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);