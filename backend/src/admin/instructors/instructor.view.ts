/**
 * instructor.view.ts
 * ---------------------------------------------------------------------------
 * What an instructor looks like in API responses - and, just as important,
 * what it NEVER contains: no password hash, no tokens, no invite links.
 *
 * Two safety habits live here:
 *  1. Queries ask the database for ONLY these fields (`select`), so sensitive
 *     columns are never even loaded into memory.
 *  2. The mapper copies fields one by one, so a column added to the table in
 *     the future can never leak into responses by accident.
 */
import type { AccountStatus, Prisma } from '@prisma/client';

/** The columns we read for an instructor. */
export const instructorSelect = {
  id: true,
  email: true,
  fullName: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type InstructorRow = Prisma.UserGetPayload<{ select: typeof instructorSelect }>;

export interface InstructorSummary {
  id: string;
  email: string;
  fullName: string;
  status: AccountStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export function toInstructorSummary(row: InstructorRow): InstructorSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    status: row.status,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

/** Where an instructor is in the invitation process. */
export type InviteState = 'accepted' | 'pending' | 'expired';