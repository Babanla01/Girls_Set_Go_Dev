/**
 * cohorts.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only web addresses for cohorts and their teaching assignments
 * (class-level @Roles(ADMIN)).
 *
 *   POST   /api/v1/admin/cohorts                              create
 *   GET    /api/v1/admin/cohorts                              list (filters, phase, pages)
 *   GET    /api/v1/admin/cohorts/:id                          one cohort + its instructors
 *   PATCH  /api/v1/admin/cohorts/:id                          edit name / dates / capacity
 *   POST   /api/v1/admin/cohorts/:id/archive                  retire
 *   POST   /api/v1/admin/cohorts/:id/restore                  bring back
 *   POST   /api/v1/admin/cohorts/:id/instructors              assign an instructor
 *   DELETE /api/v1/admin/cohorts/:id/instructors/:instructorId  remove an instructor
 */
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CohortsService } from './cohorts.service';
import { AssignInstructorDto } from './dto/assign-instructor.dto';
import { CreateCohortDto } from './dto/create-cohort.dto';
import { ListCohortsQuery } from './dto/list-cohorts.query';
import { UpdateCohortDto } from './dto/update-cohort.dto';

@Roles(Role.ADMIN)
@Controller('admin/cohorts')
export class CohortsController {
  constructor(private readonly cohorts: CohortsService) {}

  @Post()
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateCohortDto, @Req() req: Request) {
    return this.cohorts.create(admin, dto, getRequestContext(req));
  }

  @Get()
  list(@Query() query: ListCohortsQuery) {
    return this.cohorts.list(query);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.cohorts.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCohortDto,
    @Req() req: Request,
  ) {
    return this.cohorts.update(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.cohorts.archive(admin, id, getRequestContext(req));
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.cohorts.restore(admin, id, getRequestContext(req));
  }

  @Post(':id/instructors')
  @HttpCode(200)
  assignInstructor(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignInstructorDto,
    @Req() req: Request,
  ) {
    return this.cohorts.assignInstructor(admin, id, dto, getRequestContext(req));
  }

  @Delete(':id/instructors/:instructorId')
  removeInstructor(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('instructorId', new ParseUUIDPipe()) instructorId: string,
    @Req() req: Request,
  ) {
    return this.cohorts.removeInstructor(admin, id, instructorId, getRequestContext(req));
  }
}