/**
 * profile.controller.ts  (students only)
 * ---------------------------------------------------------------------------
 *   GET   /api/v1/students/me/profile   her profile: editable details, the choices, her track and cohort
 *   PATCH /api/v1/students/me/profile   change phone, school, grade, interests, goal or after-bootcamp choice
 *
 * Name, email, date of birth, location and guardian details are changed through support.
 */
import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';

@Roles(Role.STUDENT)
@Controller('students/me')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('profile')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.profile.get(user);
  }

  @Patch('profile')
  update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto, @Req() req: Request) {
    return this.profile.update(user, dto, getRequestContext(req));
  }
}
