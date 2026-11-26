/**
 * profile.module.ts
 * ---------------------------------------------------------------------------
 * A student's own profile (interests, goals, school...) and the settings remembered per user
 * (the profile panel's state). Uses the global Prisma and audit services.
 */
import { Module } from '@nestjs/common';

import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  controllers: [ProfileController, PreferencesController],
  providers: [ProfileService, PreferencesService],
})
export class ProfileModule {}
