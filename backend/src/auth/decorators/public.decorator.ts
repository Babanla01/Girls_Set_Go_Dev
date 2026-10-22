/**
 * public.decorator.ts
 * ---------------------------------------------------------------------------
 * @Public() marks a route that anyone may call without signing in.
 *
 * Every route is LOCKED by default; forgetting this decorator makes a route
 * too strict (safe), never too open (dangerous).
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);