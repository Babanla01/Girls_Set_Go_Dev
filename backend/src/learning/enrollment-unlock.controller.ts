/**
 * enrollment-unlock.controller.ts
 * ---------------------------------------------------------------------------
 * Opening a week early for ONE student (admins, and the instructor of that student's cohort).
 *
 *   POST /api/v1/enrollments/:enrollmentId/week-unlocks     body: { weekId, reason }
 */
import { Body, Controller, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { EarlyOpenDto } from './dto/early-open.dto';
import { WeekUnlockService } from './week-unlock.service';

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('enrollments')
export class EnrollmentUnlockController {
  constructor(private readonly unlocks: WeekUnlockService) {}

  @Post(':enrollmentId/week-unlocks')
  openEarly(
    @CurrentUser() user: AuthenticatedUser,
    @Param('enrollmentId', new ParseUUIDPipe()) enrollmentId: string,
    @Body() dto: EarlyOpenDto,
    @Req() req: Request,
  ) {
    return this.unlocks.openEarly(user, enrollmentId, dto, getRequestContext(req));
  }
}
