/**
 * assignments.controller.ts
 * ---------------------------------------------------------------------------
 * The student's assignments (students only).
 *
 *   GET /api/v1/learn/assignments?tab=all|todo|submitted|feedback     the list
 *   GET /api/v1/learn/assignments/:assignmentId                       one assignment (title and reason only if its week is locked)
 */
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AssignmentTab, AssignmentsService } from './assignments.service';

@Roles(Role.STUDENT)
@Controller('learn/assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('tab') tab: string = 'all') {
    return this.assignments.list(user, tab as AssignmentTab);
  }

  @Get(':assignmentId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string) {
    return this.assignments.detail(user, assignmentId);
  }
}
