/**
 * cms.module.ts
 * ---------------------------------------------------------------------------
 * The website editor (content management):
 *   site settings    applications open/closed, contact details, tagline, banner rules
 *   media library    pictures with permanent keys, alt text, versions and "used on"
 *   people           public team / instructor profiles
 * Later batches add pages (with drafts, history and publishing), banners and videos.
 */
import { Module, OnModuleInit } from '@nestjs/common';

import { SettingsRegistry } from '../../platform/settings/settings.registry';
import { MediaController } from './media/media.controller';
import { MediaImageService } from './media/media-image.service';
import { MediaService } from './media/media.service';
import { MediaUsageService } from './media/media-usage.service';
import { PublicFilesController } from './media/public-files.controller';
import { PeopleController } from './people/people.controller';
import { PeopleService } from './people/people.service';
import { PublicPeopleController } from './people/public-people.controller';
import { ApplicationsOpenGuard } from './site/applications-open.guard';
import { PublicSiteController } from './site/public-site.controller';
import { SiteService } from './site/site.service';
import { SITE_SETTING_DEFINITIONS } from './site/site-settings.definitions';

@Module({
  controllers: [PublicSiteController, MediaController, PublicFilesController, PeopleController, PublicPeopleController],
  providers: [SiteService, MediaService, MediaImageService, MediaUsageService, PeopleService, ApplicationsOpenGuard],
  // Exported so other parts of the system can use them (for example the learning portal
  // creating a website profile for a new instructor, or the signup route using the guard).
  exports: [MediaUsageService, PeopleService, ApplicationsOpenGuard],
})
export class CmsModule implements OnModuleInit {
  constructor(private readonly settings: SettingsRegistry) {}

  onModuleInit(): void {
    this.settings.register(SITE_SETTING_DEFINITIONS);
  }
}