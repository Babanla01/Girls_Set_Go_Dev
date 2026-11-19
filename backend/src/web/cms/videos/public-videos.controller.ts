/**
 * public-videos.controller.ts
 * ---------------------------------------------------------------------------
 *   GET /api/v1/public/videos                          published videos (filters, pages) with the count in each category
 *   GET /api/v1/public/videos/:slug                    one video in full (captions link, transcript, who appears)
 *   GET /api/v1/public/videos/:slug/captions.vtt       the English captions of a published video
 *   GET /api/v1/files/video/:file?v=<version>          the file of an UPLOADED, published video (supports seeking)
 *
 * No sign-in. Only PUBLISHED videos are ever visible; drafts are not reachable here.
 * Cheap to call: not rate-limited. The video file is sent in slices on request so a
 * viewer can skip ahead, and may be cached for a year (the version is in the address).
 */
import { Controller, Get, Header, NotFoundException, Param, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { Public } from '../../../auth/decorators/public.decorator';
import { StorageService } from '../../../platform/storage/storage.service';
import { PublicFileQuery } from '../media/dto/public-file.query';
import { sendStoredFile } from './byte-range';
import { PublicVideosQuery } from './dto/public-videos.query';
import { VideosService } from './videos.service';

@Public()
@SkipThrottle()
@Controller()
export class PublicVideosController {
  constructor(
    private readonly videos: VideosService,
    private readonly storage: StorageService,
  ) {}

  @Get('public/videos')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  list(@Query() query: PublicVideosQuery) {
    return this.videos.listPublic(query);
  }

  @Get('public/videos/:slug')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  one(@Param('slug') slug: string) {
    return this.videos.getPublic(slug);
  }

  @Get('public/videos/:slug/captions.vtt')
  async captions(@Param('slug') slug: string, @Res({ passthrough: true }) res: Response): Promise<string> {
    const text = await this.videos.captionsOf(slug);
    res.set({
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    return text;
  }

  @Get('files/video/:file')
  async file(
    @Param('file') file: string,
    @Query() query: PublicFileQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    const handle = await this.videos.findPublicFile(file);
    if (!handle) throw new NotFoundException('Video not found.');

    const current = query.v === String(handle.version);
    return sendStoredFile(this.storage, req, res, {
      key: handle.key,
      contentType: handle.contentType,
      cacheControl: current ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      etag: `W/"video-v${handle.version}"`,
    });
  }
}