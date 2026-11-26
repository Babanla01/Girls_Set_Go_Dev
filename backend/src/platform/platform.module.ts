/**
 * platform.module.ts
 * ---------------------------------------------------------------------------
 * The shared building blocks that BOTH the website side and the learning portal
 * use, so nobody builds a second copy:
 *
 *   SettingsRegistry / SettingsService   named settings with rules and defaults
 *   StorageService                       the one door to file storage
 *   SignedUrlService                     short-lived links for private files
 *   NotificationsService                 the notification bell (every role); call notify(...) from anywhere
 *
 * Global: any module can inject these without importing this one.
 */
import { Global, Module } from '@nestjs/common';

import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsRegistry } from './settings/settings.registry';
import { SettingsService } from './settings/settings.service';
import { LocalDiskStorage } from './storage/local-disk.storage';
import { PrivateFilesController } from './storage/private-files.controller';
import { SignedUrlService } from './storage/signed-url.service';
import { StorageService } from './storage/storage.service';
import { STORAGE_PROVIDER } from './storage/storage.types';

@Global()
@Module({
  controllers: [SettingsController, PrivateFilesController, NotificationsController],
  providers: [
    SettingsRegistry,
    SettingsService,
    StorageService,
    SignedUrlService,
    NotificationsService,
    // To move files to cloud storage later, point this at a different class. Nothing else changes.
    { provide: STORAGE_PROVIDER, useClass: LocalDiskStorage },
  ],
  exports: [SettingsRegistry, SettingsService, StorageService, SignedUrlService, NotificationsService],
})
export class PlatformModule {}