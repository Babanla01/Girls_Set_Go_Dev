/**
 * achievements.controller.ts
 * ---------------------------------------------------------------------------
 * A student's badges and activity feed (students only).
 *
 *   GET /api/v1/learn/badges                   earned badges (with dates) and the ones still to earn ("how to earn")
 *   GET /api/v1/learn/activity?page=&pageSize= her recent activity, newest first
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AchievementsService } from './achievements.service';
import { ActivityQuery } from './dto/activity.query';

@Roles(Role.STUDENT)
@Controller('learn')
export class AchievementsController {
  constructor(private readonly achievements: AchievementsService) {}

  @Get('badges')
  badges(@CurrentUser() user: AuthenticatedUser) {
    return this.achievements.myBadges(user);
  }

  @Get('activity')
  activity(@CurrentUser() user: AuthenticatedUser, @Query() query: ActivityQuery) {
    return this.achievements.myActivity(user, query);
  }
}
