/**
 * tracks.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only web addresses for tracks (the class-level @Roles(ADMIN) covers
 * every route: students/instructors get 403, signed-out visitors get 401).
 *
 *   POST  /api/v1/admin/tracks              create
 *   GET   /api/v1/admin/tracks              list (search, filter, pages)
 *   GET   /api/v1/admin/tracks/:id          one track
 *   PATCH /api/v1/admin/tracks/:id          edit name / description
 *   POST  /api/v1/admin/tracks/:id/archive  retire (refused while it has active courses)
 *   POST  /api/v1/admin/tracks/:id/restore  bring back
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CreateTrackDto } from './dto/create-track.dto';
import { ListTracksQuery } from './dto/list-tracks.query';
import { UpdateTrackDto } from './dto/update-track.dto';
import { TracksService } from './tracks.service';

@Roles(Role.ADMIN)
@Controller('admin/tracks')
export class TracksController {
  constructor(private readonly tracks: TracksService) {}

  @Post()
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateTrackDto, @Req() req: Request) {
    return this.tracks.create(admin, dto, getRequestContext(req));
  }

  @Get()
  list(@Query() query: ListTracksQuery) {
    return this.tracks.list(query);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.tracks.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTrackDto,
    @Req() req: Request,
  ) {
    return this.tracks.update(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.tracks.archive(admin, id, getRequestContext(req));
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.tracks.restore(admin, id, getRequestContext(req));
  }
}