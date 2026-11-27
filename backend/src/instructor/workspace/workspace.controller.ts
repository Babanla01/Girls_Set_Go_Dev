/**
 * workspace.controller.ts
 * ---------------------------------------------------------------------------
 * The instructor workspace. Instructors see only their own cohorts; admins see every current
 * cohort (checked against the database on every request).
 *
 *   GET /api/v1/instructor/dashboard                    numbers, course cards, review queue
 *   GET /api/v1/instructor/students                     the students list (search, filters, paging, counts)
 *   GET /api/v1/instructor/students/export              the same list as a CSV file (10 a minute)
 *   GET /api/v1/instructor/students/:enrollmentId       one student: progress, work, goal, activity
 */
import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { StudentsQuery } from './dto/students.query';
import { InstructorDashboardService } from './instructor-dashboard.service';
import { InstructorStudentsService } from './instructor-students.service';

@Roles(Role.INSTRUCTOR, Role.ADMIN)
@Controller('instructor')
export class WorkspaceController {
  constructor(
    private readonly dashboard: InstructorDashboardService,
    private readonly students: InstructorStudentsService,
  ) {}

  @Get('dashboard')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboard.get(user);
  }

  @Get('students')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: StudentsQuery) {
    return this.students.list(user, query);
  }

  // Declared BEFORE ":enrollmentId" so "export" is never mistaken for an id.
  @Get('students/export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: StudentsQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.students.exportCsv(user, query, getRequestContext(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="students-${this.students.fileDate()}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }

  @Get('students/:enrollmentId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('enrollmentId', new ParseUUIDPipe()) enrollmentId: string) {
    return this.students.detail(user, enrollmentId);
  }
}
