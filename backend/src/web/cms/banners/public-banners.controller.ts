/**
 * public-banners.controller.ts
 * ---------------------------------------------------------------------------
 *   GET /api/v1/public/banners?placement=HOME     (no sign-in)
 * The slides to show on that page right now (published and inside their schedule),
 * in order, together with the banner rules: seconds per slide, fade, colour layer,
 * the scrolling tagline, and the fixed accessibility rules (pause on hover / focus /
 * tap, a visible pause button, stand still when the visitor asks for reduced motion).
 * A video slide always comes with its picture, for use until the video loads.
 *
 * Cheap to call: not rate-limited, cacheable for a minute. Slides that start or end
 * at a set time appear and disappear on their own as the cache refreshes.
 */
import { Controller, Get, Header, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../../../auth/decorators/public.decorator';
import { BannersService } from './banners.service';
import { PublicBannersQuery } from './dto/public-banners.query';

@Public()
@SkipThrottle()
@Controller('public')
export class PublicBannersController {
  constructor(private readonly banners: BannersService) {}

  @Get('banners')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  list(@Query() query: PublicBannersQuery) {
    return this.banners.listPublic(query.placement);
  }
}