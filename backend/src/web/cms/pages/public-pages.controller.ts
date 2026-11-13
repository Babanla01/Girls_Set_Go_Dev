/**
 * public-pages.controller.ts
 * ---------------------------------------------------------------------------
 *   GET /api/v1/public/pages                    every live page (address, title) - for menus and the sitemap
 *   GET /api/v1/public/page?path=/about         one LIVE page, ready for the website to draw
 *   GET /api/v1/public/page-preview/:token      a page's DRAFT, for a preview link made by an admin
 *
 * No sign-in. Visitors only ever receive a PUBLISHED version; drafts are reachable
 * only through a short-lived preview token. Cheap to call: not rate-limited, and
 * the live page may be cached for 30 seconds (the website is also told to refresh
 * as soon as a page is published).
 */
import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

import { Public } from '../../../auth/decorators/public.decorator';
import { PublicPageQuery } from './dto/public-page.query';
import { PagesService } from './pages.service';

@Public()
@SkipThrottle()
@Controller('public')
export class PublicPagesController {
  constructor(private readonly pages: PagesService) {}

  @Get('pages')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300')
  list() {
    return this.pages.listPublic();
  }

  @Get('page')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300')
  one(@Query() query: PublicPageQuery) {
    return this.pages.getPublic(query.path);
  }

  @Get('page-preview/:token')
  preview(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    // A draft must never be stored by a browser or shared cache, nor found by a search engine.
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    return this.pages.renderPreview(token);
  }
}