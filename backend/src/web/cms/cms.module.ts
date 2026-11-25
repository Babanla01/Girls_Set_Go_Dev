/**
 * cms.module.ts
 * ---------------------------------------------------------------------------
 * The website editor (content management):
 *   site settings    applications open/closed, contact details, tagline, banner rules
 *   media library    pictures with permanent keys, alt text, versions and "used on"
 *   people           public team / instructor profiles
 *   pages            sections, autosaved drafts, numbered published versions, history, previews
 *   videos           the Creative Studio library: uploads, YouTube/Vimeo, captions, consent
 *   banners          page banner slides: photo or muted looping video, per-page order, schedule
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
import { BannersController } from './banners/banners.controller';
import { BannersService } from './banners/banners.service';
import { PublicBannersController } from './banners/public-banners.controller';
import { PageRenderService } from './pages/page-render.service';
import { PagesController } from './pages/pages.controller';
import { PagesService } from './pages/pages.service';
import { PreviewTokenService } from './pages/preview-token.service';
import { PublicPagesController } from './pages/public-pages.controller';
import { RevalidationService } from './pages/revalidation.service';
import { ApplicationsOpenGuard } from './site/applications-open.guard';
import { PublicSiteController } from './site/public-site.controller';
import { SiteService } from './site/site.service';
import { SITE_SETTING_DEFINITIONS } from './site/site-settings.definitions';
import { PublicVideosController } from './videos/public-videos.controller';
import { VideosController } from './videos/videos.controller';
import { VideosService } from './videos/videos.service';

@Module({
  controllers: [
    PublicSiteController,
    MediaController,
    PublicFilesController,
    PeopleController,
    PublicPeopleController,
    PagesController,
    PublicPagesController,
    VideosController,
    PublicVideosController,
    BannersController,
    PublicBannersController,
  ],
  providers: [
    SiteService,
    MediaService,
    MediaImageService,
    MediaUsageService,
    PeopleService,
    ApplicationsOpenGuard,
    PagesService,
    PageRenderService,
    PreviewTokenService,
    RevalidationService,
    VideosService,
    BannersService,
  ],
  // Exported so other parts of the system can use them (for example the learning portal
  // creating a website profile for a new instructor, or the signup route using the guard).
  exports: [MediaUsageService, PeopleService, ApplicationsOpenGuard, PagesService, VideosService, BannersService],
})
export class CmsModule implements OnModuleInit {
  constructor(private readonly settings: SettingsRegistry) {}

  onModuleInit(): void {
    this.settings.register(SITE_SETTING_DEFINITIONS);
  }
}