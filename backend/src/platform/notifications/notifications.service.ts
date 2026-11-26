/**
 * notifications.service.ts
 * ---------------------------------------------------------------------------
 * The notification bell, for every role.
 *
 * FOR CODE THAT CREATES NOTIFICATIONS (the learning portal, admissions, grading ...):
 *
 *     await this.notifications.notify(studentId, 'feedback.ready', { assignmentTitle, link }, { db: tx });
 *     await this.notifications.notifyMany(studentIds, 'announcement.new', { title }, { dedupeKey: `announcement:${id}` });
 *     await this.notifications.notifyAdmins('application.new', { reference });
 *
 *  - Pass `db: tx` to write inside your own database transaction: the notification is
 *    then saved or rolled back together with whatever caused it.
 *  - Pass `dedupeKey` when an event could run twice: the same person is never notified
 *    twice for the same key.
 *  - An unknown type is logged and skipped (it never breaks the action that caused it).
 *
 * FOR THE PERSON (every signed-in user): list, unread count, mark one or all as read.
 * Everyone only ever sees their OWN notifications.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AccountStatus, Prisma, Role } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { buildPage, Paginated, toSkipTake } from '../../common/pagination/pagination';
import type { DbClient } from '../../common/types/db-client';
import { PrismaService } from '../../prisma/prisma.service';
import type { ListNotificationsQuery } from './dto/list-notifications.query';
import { describeNotification, isKnownNotificationType } from './notification.types';

export interface NotifyOptions {
  /** Write inside this database transaction. */
  db?: DbClient;
  /** The same person is never notified twice for the same key. */
  dedupeKey?: string;
}

const CHUNK = 2000;

type Row = { id: string; type: string; payload: Prisma.JsonValue; createdAt: Date; readAt: Date | null };

export function toNotificationView(row: Row) {
  return {
    id: row.id,
    type: row.type,
    ...describeNotification(row.type, row.payload),
    read: row.readAt !== null,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ creating

  async notify(recipientId: string, type: string, payload: Record<string, unknown> = {}, options: NotifyOptions = {}): Promise<void> {
    await this.notifyMany([recipientId], type, payload, options);
  }

  /** Notifies many people at once. Returns how many notifications were created. */
  async notifyMany(recipientIds: string[], type: string, payload: Record<string, unknown> = {}, options: NotifyOptions = {}): Promise<number> {
    if (!isKnownNotificationType(type)) {
      this.logger.error(`Unknown notification type "${type}": nothing was sent. Add it to notification.types.ts.`);
      return 0;
    }

    const recipients = [...new Set(recipientIds)];
    if (recipients.length === 0) return 0;

    const db = options.db ?? this.prisma;
    let created = 0;
    for (let start = 0; start < recipients.length; start += CHUNK) {
      const result = await db.platformNotification.createMany({
        data: recipients.slice(start, start + CHUNK).map((recipientId) => ({
          recipientId,
          type,
          payload: payload as Prisma.InputJsonObject,
          dedupeKey: options.dedupeKey ?? null,
        })),
        skipDuplicates: true, // the "same key, same person" guard
      });
      created += result.count;
    }
    return created;
  }

  /** Notifies every active admin. */
  async notifyAdmins(type: string, payload: Record<string, unknown> = {}, options: NotifyOptions = {}): Promise<number> {
    const db = options.db ?? this.prisma;
    const admins = await db.user.findMany({ where: { role: Role.ADMIN, status: AccountStatus.ACTIVE }, select: { id: true } });
    return this.notifyMany(admins.map((admin) => admin.id), type, payload, options);
  }

  // ------------------------------------------------------------------- reading

  async list(user: AuthenticatedUser, query: ListNotificationsQuery): Promise<Paginated<ReturnType<typeof toNotificationView>> & { unreadCount: number }> {
    const where: Prisma.PlatformNotificationWhereInput = { recipientId: user.id, ...(query.unread ? { readAt: null } : {}) };

    const [total, rows, unreadCount] = await Promise.all([
      this.prisma.platformNotification.count({ where }),
      this.prisma.platformNotification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: { id: true, type: true, payload: true, createdAt: true, readAt: true },
      }),
      this.unreadCount(user),
    ]);
    return { ...buildPage(rows.map(toNotificationView), total, query), unreadCount };
  }

  unreadCount(user: AuthenticatedUser): Promise<number> {
    return this.prisma.platformNotification.count({ where: { recipientId: user.id, readAt: null } });
  }

  /** Marks one of MY notifications as read (and says so again, harmlessly, if it already was). */
  async markRead(user: AuthenticatedUser, id: string) {
    await this.prisma.platformNotification.updateMany({ where: { id, recipientId: user.id, readAt: null }, data: { readAt: new Date() } });

    const row = await this.prisma.platformNotification.findFirst({
      where: { id, recipientId: user.id },
      select: { id: true, type: true, payload: true, createdAt: true, readAt: true },
    });
    if (!row) throw new NotFoundException('Notification not found.'); // also the answer for someone else's notification
    return { notification: toNotificationView(row), unreadCount: await this.unreadCount(user) };
  }

  async markAllRead(user: AuthenticatedUser) {
    const result = await this.prisma.platformNotification.updateMany({ where: { recipientId: user.id, readAt: null }, data: { readAt: new Date() } });
    return { updated: result.count, unreadCount: 0 };
  }
}