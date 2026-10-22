/**
 * courses.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only web addresses for courses (class-level @Roles(ADMIN)).
 *
 *   POST  /api/v1/admin/courses                  create (inside a track, as a draft)
 *   GET   /api/v1/admin/courses                  list (filter by track, status, search)
 *   GET   /api/v1/admin/courses/:id              one course
 *   PATCH /api/v1/admin/courses/:id              edit title / description
 *   POST  /api/v1/admin/courses/:id/publish      draft -> published
 *   POST  /api/v1/admin/courses/:id/unpublish    published -> draft (refused with active cohorts)
 *   POST  /api/v1/admin/courses/:id/archive      retire (refused with active cohorts)
 *   POST  /api/v1/admin/courses/:id/restore      bring back as a draft
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { ListCoursesQuery } from './dto/list-courses.query';
import { UpdateCourseDto } from './dto/update-course.dto';

@Roles(Role.ADMIN)
@Controller('admin/courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Post()
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateCourseDto, @Req() req: Request) {
    return this.courses.create(admin, dto, getRequestContext(req));
  }

  @Get()
  list(@Query() query: ListCoursesQuery) {
    return this.courses.list(query);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.courses.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCourseDto,
    @Req() req: Request,
  ) {
    return this.courses.update(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.courses.publish(admin, id, getRequestContext(req));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.courses.unpublish(admin, id, getRequestContext(req));
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.courses.archive(admin, id, getRequestContext(req));
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.courses.restore(admin, id, getRequestContext(req));
  }
}