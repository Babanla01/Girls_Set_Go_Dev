/**
 * dashboard.controller.ts  (students only)
 * ---------------------------------------------------------------------------
 *   GET /api/v1/learn/dashboard   the learning dashboard for a student whose course is open
 *
 * (Pending, declined and accepted students use GET /api/v1/students/me/dashboard.)
 */
import { Controller, Get } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';

@Roles(Role.STUDENT)
@Controller('learn')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboard.get(user);
  }
}
