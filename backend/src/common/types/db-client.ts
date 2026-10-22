/**
 * db-client.ts
 * ---------------------------------------------------------------------------
 * "Something we can run database queries on" - either the normal connection
 * or a transaction in progress.
 *
 * Why it exists: services such as the audit log accept one of these, so the
 * SAME code can run on its own or as part of a transaction. That is how
 * "create the user + queue the email + write the audit entry" can succeed or
 * fail together as one unit.
 */
import type { Prisma } from '@prisma/client';

export type DbClient = Prisma.TransactionClient;