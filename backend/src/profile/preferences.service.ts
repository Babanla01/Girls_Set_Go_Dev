/**
 * preferences.service.ts
 * ---------------------------------------------------------------------------
 * Small settings a person keeps for herself, remembered per user. For now: whether the profile
 * panel is OPEN, COLLAPSED (a thin rail with icons) or CLOSED. Everyone starts with OPEN; a
 * row exists only after someone has changed a setting. Works for every role.
 */
import { Injectable } from '@nestjs/common';
import { PanelState } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdatePreferencesDto } from './dto/preferences.dto';

@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: AuthenticatedUser) {
    const row = await this.prisma.userPreference.findUnique({ where: { userId: user.id }, select: { profilePanel: true } });
    return { profilePanel: row?.profilePanel ?? PanelState.OPEN };
  }

  async set(user: AuthenticatedUser, dto: UpdatePreferencesDto) {
    const row = await this.prisma.userPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, profilePanel: dto.profilePanel },
      update: { profilePanel: dto.profilePanel },
      select: { profilePanel: true },
    });
    return { profilePanel: row.profilePanel };
  }
}
