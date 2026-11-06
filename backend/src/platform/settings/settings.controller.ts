/**
 * settings.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only screen for settings (class-level @Roles(ADMIN): students and
 * instructors get 403, signed-out visitors get 401).
 *
 *   GET   /api/v1/admin/settings?group=site   every setting (or one group) with value and default
 *   PATCH /api/v1/admin/settings              save one or more values (all or nothing)
 */
import { Body, Controller, Get, Patch, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ListSettingsQuery } from './dto/list-settings.query';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';

@Roles(Role.ADMIN)
@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async list(@Query() query: ListSettingsQuery) {
    return { settings: await this.settings.describe(query.group) };
  }

  @Patch()
  async update(@CurrentUser() admin: AuthenticatedUser, @Body() dto: UpdateSettingsDto, @Req() req: Request) {
    return { settings: await this.settings.update(dto.values, admin, getRequestContext(req)) };
  }
}