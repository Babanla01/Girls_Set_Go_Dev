/**
 * banners.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only banner slides (class-level @Roles(ADMIN)).
 *
 *   POST   /api/v1/admin/banners                 new slide (draft)
 *   GET    /api/v1/admin/banners?placement=HOME  a page's slides in order (or every slide, newest first)
 *   POST   /api/v1/admin/banners/reorder         order the slides of one page
 *   GET    /api/v1/admin/banners/:id             one slide, with what is missing to publish it
 *   PATCH  /api/v1/admin/banners/:id             change title, tagline, picture, video, pages, schedule
 *   POST   /api/v1/admin/banners/:id/publish     make it live (inside its schedule)
 *   POST   /api/v1/admin/banners/:id/unpublish   take it off
 *   DELETE /api/v1/admin/banners/:id             delete a draft slide
 *
 * The timing and motion rules (seconds per slide, fade, colour layer, tagline speed) are website
 * settings: GET / PATCH /api/v1/admin/settings?group=site (keys site.banner_* and site.tagline_*).
 */
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../../auth/auth.types';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { BannersService } from './banners.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { ListBannersQuery } from './dto/list-banners.query';
import { ReorderBannersDto } from './dto/reorder-banners.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';

@Roles(Role.ADMIN)
@Controller('admin/banners')
export class BannersController {
  constructor(private readonly banners: BannersService) {}

  @Post()
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateBannerDto, @Req() req: Request) {
    return this.banners.create(admin, dto, getRequestContext(req));
  }

  @Get()
  list(@Query() query: ListBannersQuery) {
    return this.banners.list(query);
  }

  // "reorder" is a fixed word, declared before the ":id" routes so it is never mistaken for an id.
  @Post('reorder')
  @HttpCode(200)
  reorder(@CurrentUser() admin: AuthenticatedUser, @Body() dto: ReorderBannersDto, @Req() req: Request) {
    return this.banners.reorder(admin, dto, getRequestContext(req));
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.banners.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBannerDto,
    @Req() req: Request,
  ) {
    return this.banners.update(admin, id, dto, getRequestContext(req));
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.banners.publish(admin, id, getRequestContext(req));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.banners.unpublish(admin, id, getRequestContext(req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() admin: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request): Promise<void> {
    await this.banners.remove(admin, id, getRequestContext(req));
  }
}