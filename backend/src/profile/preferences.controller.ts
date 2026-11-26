/**
 * preferences.controller.ts  (every signed-in role)
 * ---------------------------------------------------------------------------
 *   GET /api/v1/me/preferences   her saved settings (the profile panel: OPEN, COLLAPSED or CLOSED)
 *   PUT /api/v1/me/preferences   save them
 */
import { Body, Controller, Get, Put } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UpdatePreferencesDto } from './dto/preferences.dto';
import { PreferencesService } from './preferences.service';

@Controller('me/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.get(user);
  }

  @Put()
  set(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdatePreferencesDto) {
    return this.preferences.set(user, dto);
  }
}
