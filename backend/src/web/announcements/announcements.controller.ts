/**
 * announcements.controller.ts
 * ---------------------------------------------------------------------------
 * Writing announcements: admins and instructors (students get 403).
 *
 *   GET    /api/v1/announcements/audience-options     who I may write to (admin: all/tracks/cohorts; instructor: her cohorts)
 *   GET    /api/v1/announcements/audience-preview     "this will reach N learners"
 *   POST   /api/v1/announcements                      new announcement (draft)
 *   GET    /api/v1/announcements                      list (status, audience, search, mine, pages)
 *   GET    /api/v1/announcements/:id                  one announcement
 *   PATCH  /api/v1/announcements/:id                  change it (an instructor only her own)
 *   POST   /api/v1/announcements/:id/publish          make it visible and notify the learners
 *   POST   /api/v1/announcements/:id/unpublish        hide it again
 *   DELETE /api/v1/announcements/:id                  delete a draft
 */
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AnnouncementsService } from './announcements.service';
import { AudiencePreviewQuery } from './dto/audience-preview.query';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { ListAnnouncementsQuery } from './dto/list-announcements.query';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  // Fixed words are declared before the ":id" routes so they are never mistaken for an id.
  @Get('audience-options')
  options(@CurrentUser() user: AuthenticatedUser) {
    return this.announcements.options(user);
  }

  @Get('audience-preview')
  preview(@CurrentUser() user: AuthenticatedUser, @Query() query: AudiencePreviewQuery) {
    return this.announcements.preview(user, query);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAnnouncementDto, @Req() req: Request) {
    return this.announcements.create(user, dto, getRequestContext(req));
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListAnnouncementsQuery) {
    return this.announcements.list(user, query);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.announcements.getOne(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAnnouncementDto,
    @Req() req: Request,
  ) {
    return this.announcements.update(user, id, dto, getRequestContext(req));
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.announcements.publish(user, id, getRequestContext(req));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.announcements.unpublish(user, id, getRequestContext(req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request): Promise<void> {
    await this.announcements.remove(user, id, getRequestContext(req));
  }
}