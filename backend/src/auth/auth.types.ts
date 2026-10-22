/**
 * auth.types.ts
 * ---------------------------------------------------------------------------
 * Small shared shapes used across the auth code.
 */
import type { Role } from '@prisma/client';
import type { Request } from 'express';

/** The signed-in person, as attached to each request by the AuthGuard. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
}

/** An Express request after the AuthGuard has run. */
export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  sessionId: string;
}

/** Facts about where a request came from (for sessions and the audit log). */
export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export function getRequestContext(req: Request): RequestContext {
  const userAgent = req.headers['user-agent'];
  return {
    ipAddress: req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}