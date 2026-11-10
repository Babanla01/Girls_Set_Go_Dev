/**
 * files.controller.ts
 * ---------------------------------------------------------------------------
 * Serves a stored file from a signed link:
 *
 *   GET /api/v1/files/:token
 *
 * The token IS the permission (it was made for one file and expires in minutes), so this
 * route needs no sign-in: that is what lets an <img> tag or a new tab open it. Anything
 * wrong with the token - tampered, expired, unknown file - answers the same 404.
 *
 * Safety headers on every file: never cached, never sniffed as another type, and (except
 * PDFs, which browsers need to render) a policy that stops any script inside the file from
 * running. Only PDFs and images are shown in the page; everything else downloads.
 */
import { Controller, Get, NotFoundException, Param, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { StorageService } from './storage.service';

/** RFC 5987 encoding, so any file name (accents, spaces, quotes) is safe in a header. */
const encodeName = (name: string): string =>
  encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

@Public()
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Get(':token')
  async open(@Param('token') token: string, @Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    const file = await this.storage.openFromToken(token);
    if (!file) throw new NotFoundException('This link has expired or is not valid.');

    response.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-site',
      ...(file.contentType === 'application/pdf' ? {} : { 'Content-Security-Policy': "default-src 'none'; sandbox" }),
    });

    return new StreamableFile(file.stream, {
      type: file.contentType,
      length: file.sizeBytes,
      disposition: `${file.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeName(file.name)}`,
    });
  }
}
