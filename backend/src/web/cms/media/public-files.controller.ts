/**
 * public-files.controller.ts
 * ---------------------------------------------------------------------------
 *   GET /api/v1/files/public/:folder/:file?v=<version>&w=<width>
 *
 * Serves the pictures of the media library to the PUBLIC website (no sign-in).
 *  - Only pictures registered in the media library are served, never an
 *    arbitrary file, and never anything under "private/".
 *  - Because the version is part of the address, a picture can be cached by
 *    browsers for a year; replacing it changes the version and so the address.
 *  - Other websites (the main site runs on a different address) may show these
 *    pictures: the security header that would block that is relaxed for this
 *    route only (Cross-Origin-Resource-Policy: cross-origin).
 *  - Not rate-limited: a page can show many pictures at once.
 */
import { Controller, Get, NotFoundException, Param, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { Public } from '../../../auth/decorators/public.decorator';
import { PublicFileQuery } from './dto/public-file.query';
import { MediaService } from './media.service';

@Public()
@SkipThrottle()
@Controller('files')
export class PublicFilesController {
  constructor(private readonly media: MediaService) {}

  @Get('public/:folder/:file')
  async serve(
    @Param('folder') folder: string,
    @Param('file') file: string,
    @Query() query: PublicFileQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    const handle = await this.media.findPublic(folder, file, query.w);
    if (!handle) throw new NotFoundException('Picture not found.');

    const current = query.v === String(handle.version);
    res.set({
      ETag: handle.etag,
      'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    });

    // The browser already has this exact picture: send nothing.
    if (req.headers['if-none-match'] === handle.etag) {
      res.status(304);
      return undefined;
    }

    const stored = await handle.open();
    return new StreamableFile(stored.stream, { type: handle.contentType, length: stored.size, disposition: 'inline' });
  }
}