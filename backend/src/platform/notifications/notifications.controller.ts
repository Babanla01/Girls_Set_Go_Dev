/**
 * notifications.controller.ts
 * ---------------------------------------------------------------------------
 * The notification bell. Open to EVERY signed-in role (student, instructor, admin);
 * everyone only ever sees and changes their own notifications.
 *
 *   GET  /api/v1/notifications?unread=true&page=1   my notifications, newest first, with the unread count
 *   GET  /api/v1/notifications/unread-count         just the number for the bell badge
 *   POST /api/v1/notifications/read-all             "Mark all as read"
 *   POST /api/v1/notifications/:id/read             mark one as read
 */
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ListNotificationsQuery } from './dto/list-notifications.query';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListNotificationsQuery) {
    return this.notifications.list(user, query);
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return { unreadCount: await this.notifications.unreadCount(user) };
  }

  // "read-all" is a fixed word, declared before the ":id" route so it is never mistaken for an id.
  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.notifications.markRead(user, id);
  }
}