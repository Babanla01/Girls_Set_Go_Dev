/**
 * applications.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only web addresses for reviewing student applications (class-level
 * @Roles(ADMIN): students/instructors get 403, signed-out visitors get 401).
 *
 *   GET  /api/v1/admin/applications                  the review queue (search, filters, pages)
 *   GET  /api/v1/admin/applications/:id              everything she submitted
 *   POST /api/v1/admin/applications/:id/accept       accept into a cohort (atomic)
 *   POST /api/v1/admin/applications/:id/decline      decline (private note optional)
 *   POST /api/v1/admin/applications/:id/reopen       put a declined application back to pending
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ApplicationsService } from './applications.service';
import { AcceptApplicationDto } from './dto/accept-application.dto';
import { DeclineApplicationDto } from './dto/decline-application.dto';
import { ListApplicationsQuery } from './dto/list-applications.query';

@Roles(Role.ADMIN)
@Controller('admin/applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Get()
  list(@Query() query: ListApplicationsQuery) {
    return this.applications.list(query);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.applications.getOne(id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AcceptApplicationDto,
    @Req() req: Request,
  ) {
    return this.applications.accept(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DeclineApplicationDto,
    @Req() req: Request,
  ) {
    return this.applications.decline(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.applications.reopen(admin, id, getRequestContext(req));
  }
}