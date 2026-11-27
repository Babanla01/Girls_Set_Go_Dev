/**
 * student-announcements.controller.ts
 * ---------------------------------------------------------------------------
 *   GET /api/v1/learn/announcements?page=1      (students only)
 * The updates a student can read: for her cohort, her track, and all cohorts, newest
 * first, with a heading such as "Updates for UI/UX Design · Cohort 01". Read-only:
 * no replies, comments or reactions. A signed-out visitor gets 401, other roles 403.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { AnnouncementsService } from './announcements.service';

@Roles(Role.STUDENT)
@Controller('learn/announcements')
export class StudentAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.announcements.listForStudent(user, query);
  }
}