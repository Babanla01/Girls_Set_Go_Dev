/**
 * instructors.controller.ts
 * ---------------------------------------------------------------------------
 * The web addresses an ADMIN uses to manage instructors. The class-level
 * @Roles(Role.ADMIN) means EVERY route below is admin-only: students and
 * instructors get 403, signed-out visitors get 401.
 *
 *   POST  /api/v1/admin/instructors                     create + invite
 *   GET   /api/v1/admin/instructors                     list (search, filter, pages)
 *   GET   /api/v1/admin/instructors/:id                 one instructor + invite state
 *   PATCH /api/v1/admin/instructors/:id                 edit name / (pending) email
 *   POST  /api/v1/admin/instructors/:id/resend-invite   send a fresh invite link
 *   POST  /api/v1/admin/instructors/:id/suspend         switch off immediately
 *   POST  /api/v1/admin/instructors/:id/reactivate      switch back on
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CreateInstructorDto } from './dto/create-instructor.dto';
import { ListInstructorsQuery } from './dto/list-instructors.query';
import { SuspendInstructorDto } from './dto/suspend-instructor.dto';
import { UpdateInstructorDto } from './dto/update-instructor.dto';
import { InstructorsService } from './instructors.service';

@Roles(Role.ADMIN)
@Controller('admin/instructors')
export class InstructorsController {
  constructor(private readonly instructors: InstructorsService) {}

  @Post()
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateInstructorDto, @Req() req: Request) {
    return this.instructors.create(admin, dto, getRequestContext(req));
  }

  @Get()
  list(@Query() query: ListInstructorsQuery) {
    return this.instructors.list(query);
  }

  // ParseUUIDPipe turns a malformed id into a clean 400 instead of a database error.
  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.instructors.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateInstructorDto,
    @Req() req: Request,
  ) {
    return this.instructors.update(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/resend-invite')
  @HttpCode(200)
  resendInvite(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.instructors.resendInvite(admin, id, getRequestContext(req));
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspend(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SuspendInstructorDto,
    @Req() req: Request,
  ) {
    return this.instructors.suspend(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.instructors.reactivate(admin, id, getRequestContext(req));
  }
}