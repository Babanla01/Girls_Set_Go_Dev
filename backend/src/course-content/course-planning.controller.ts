/**
 * course-planning.controller.ts
 * ---------------------------------------------------------------------------
 * A week's assignment and live class (same people and rules as editing the course):
 *
 *   GET    /api/v1/course-content/:contentId/weeks/:weekId/planning        the week's assignment + live class
 *   PUT    /api/v1/course-content/:contentId/weeks/:weekId/assignment      create / update the assignment (send only the fields to set)
 *   DELETE /api/v1/course-content/:contentId/weeks/:weekId/assignment      remove it
 *   PUT    /api/v1/course-content/:contentId/weeks/:weekId/class-session   set the live class (Chicago date and time)
 *   DELETE /api/v1/course-content/:contentId/weeks/:weekId/class-session   remove it
 *
 * Every change answers with the new draftRevision, like the other draft edits.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CoursePlanningService } from './course-planning.service';
import { SaveAssignmentDto } from './dto/assignment.dto';
import { SaveClassSessionDto } from './dto/class-session.dto';

const uuid = () => new ParseUUIDPipe();

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('course-content')
export class CoursePlanningController {
  constructor(private readonly planning: CoursePlanningService) {}

  @Get(':contentId/weeks/:weekId/planning')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
  ) {
    return this.planning.getPlanning(user, contentId, weekId);
  }

  @Put(':contentId/weeks/:weekId/assignment')
  saveAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: SaveAssignmentDto,
  ) {
    return this.planning.saveAssignment(user, contentId, weekId, dto);
  }

  @Delete(':contentId/weeks/:weekId/assignment')
  @HttpCode(200)
  removeAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Req() req: Request,
  ) {
    return this.planning.removeAssignment(user, contentId, weekId, getRequestContext(req));
  }

  @Put(':contentId/weeks/:weekId/class-session')
  saveClassSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: SaveClassSessionDto,
  ) {
    return this.planning.saveClassSession(user, contentId, weekId, dto);
  }

  @Delete(':contentId/weeks/:weekId/class-session')
  @HttpCode(200)
  removeClassSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
  ) {
    return this.planning.removeClassSession(user, contentId, weekId);
  }
}
