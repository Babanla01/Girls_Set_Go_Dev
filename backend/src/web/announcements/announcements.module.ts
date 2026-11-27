/**
 * announcements.module.ts
 * ---------------------------------------------------------------------------
 * Announcements: short updates from admins and instructors to a cohort, a track or
 * all cohorts, shown on the student's announcements page and in the notification bell.
 *
 * Exported for the learning portal: AnnouncementsService.publishSystemAnnouncement(...)
 * creates and publishes an announcement in one call (for example "This course was updated").
 */
import { Module, OnModuleInit } from '@nestjs/common';

import { SettingsRegistry } from '../../platform/settings/settings.registry';
import { ANNOUNCEMENT_SETTING_DEFINITIONS } from './announcement.settings';
import { AnnouncementsController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';
import { AudienceService } from './audience.service';
import { StudentAnnouncementsController } from './student-announcements.controller';

@Module({
  controllers: [AnnouncementsController, StudentAnnouncementsController],
  providers: [AnnouncementsService, AudienceService],
  exports: [AnnouncementsService],
})
export class AnnouncementsModule implements OnModuleInit {
  constructor(private readonly settings: SettingsRegistry) {}

  onModuleInit(): void {
    this.settings.register(ANNOUNCEMENT_SETTING_DEFINITIONS);
  }
}