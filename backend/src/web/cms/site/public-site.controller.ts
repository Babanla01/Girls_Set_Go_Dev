/**
 * public-site.controller.ts
 * ---------------------------------------------------------------------------
 *   GET /api/v1/public/site     (no sign-in)
 * The website settings visitors may see. Cheap to call, so it is not rate-limited
 * and may be cached for a minute by the website or a CDN.
 */
import { Controller, Get, Header } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../../../auth/decorators/public.decorator';
import { SiteService } from './site.service';

@Public()
@SkipThrottle()
@Controller('public')
export class PublicSiteController {
  constructor(private readonly site: SiteService) {}

  @Get('site')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  async view() {
    return { site: await this.site.publicView() };
  }
}