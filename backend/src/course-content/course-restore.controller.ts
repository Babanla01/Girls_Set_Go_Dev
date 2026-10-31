/**
 * course-restore.controller.ts
 * ---------------------------------------------------------------------------
 * The "go back" actions for a course copy (same people and rules as editing):
 *
 *   POST /api/v1/course-content/:contentId/versions/:number/restore   make an older version live again (as a new version)
 *   POST /api/v1/course-content/:contentId/discard-draft              throw away unpublished changes, back to the live version
 */
import { Body, Controller, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CourseRestoreService } from './course-restore.service';
import { DiscardDraftDto } from './dto/discard-draft.dto';
import { RestoreDto } from './dto/restore.dto';

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('course-content')
export class CourseRestoreController {
  constructor(private readonly restoring: CourseRestoreService) {}

  @Post(':contentId/versions/:number/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', new ParseUUIDPipe()) contentId: string,
    @Param('number', new ParseIntPipe()) number: number,
    @Body() dto: RestoreDto,
    @Req() req: Request,
  ) {
    return this.restoring.restore(user, contentId, number, dto, getRequestContext(req));
  }

  @Post(':contentId/discard-draft')
  @HttpCode(200)
  discardDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', new ParseUUIDPipe()) contentId: string,
    @Body() dto: DiscardDraftDto,
    @Req() req: Request,
  ) {
    return this.restoring.discardDraft(user, contentId, dto, getRequestContext(req));
  }
}
