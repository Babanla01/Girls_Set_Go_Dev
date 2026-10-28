/**
 * students.controller.ts  (admin side)
 * ---------------------------------------------------------------------------
 * Admin-only web addresses for students (class-level @Roles(ADMIN): students
 * and instructors get 403, signed-out visitors get 401).
 *
 * Looking:
 *   GET   /api/v1/admin/students                 list (search, status, track, cohort, pages)
 *   GET   /api/v1/admin/students/:id             one student: profile, application, enrollment history
 *
 * Managing (all audited):
 *   PATCH /api/v1/admin/students/:id             edit her name, contact, school or guardian details
 *   POST  /api/v1/admin/students/:id/suspend     suspend her account (signs her out everywhere)
 *   POST  /api/v1/admin/students/:id/reactivate  let a suspended student back in
 *   POST  /api/v1/admin/students/:id/withdraw    end her enrollment (her course locks)
 *   POST  /api/v1/admin/students/:id/move        move her to another cohort
 *
 * Students cannot be created or deleted here: they join by applying, and
 * nothing is ever deleted.
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ListStudentsQuery } from './dto/list-students.query';
import { MoveStudentDto } from './dto/move-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { StudentManagementService } from './student-management.service';
import { AdminStudentsService } from './students.service';

@Roles(Role.ADMIN)
@Controller('admin/students')
export class AdminStudentsController {
  constructor(
    private readonly students: AdminStudentsService,
    private readonly management: StudentManagementService,
  ) {}

  @Get()
  list(@Query() query: ListStudentsQuery) {
    return this.students.list(query);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.students.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateStudentDto,
    @Req() req: Request,
  ) {
    return this.management.update(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.management.suspend(admin, id, getRequestContext(req));
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.management.reactivate(admin, id, getRequestContext(req));
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  withdraw(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.management.withdraw(admin, id, getRequestContext(req));
  }

  @Post(':id/move')
  @HttpCode(200)
  move(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MoveStudentDto,
    @Req() req: Request,
  ) {
    return this.management.move(admin, id, dto, getRequestContext(req));
  }
}