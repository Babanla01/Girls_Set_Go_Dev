/**
 * private-files.controller.ts
 * ---------------------------------------------------------------------------
 *   GET /api/v1/files/private/:token
 *
 * Opens a PRIVATE file (student work and the like) from a signed link.
 * The visitor must be SIGNED IN (the global guard checks that), the link must
 * be genuine and not expired, it must point into "private/", and - if it was
 * made for one person - it must be THAT person. Anything else answers the same
 * plain "not found", so nobody learns whether a file exists.
 *
 * Files are never cached by browsers or shared caches.
 */
import { Controller, Get, NotFoundException, Param, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SignedUrlService } from './signed-url.service';
import { StorageService } from './storage.service';

const NOT_FOUND = 'This link is invalid or has expired.';

/** Types a browser may show on the page; everything else is offered as a download. */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']);

/** Makes a safe download name: no quotes, slashes or control characters. */
const safeFilename = (name: string | undefined) => (name ?? 'file').replace(/[^\w. -]/g, '_').slice(0, 120) || 'file';

@Controller('files')
export class PrivateFilesController {
  constructor(
    private readonly signed: SignedUrlService,
    private readonly storage: StorageService,
  ) {}

  @Get('private/:token')
  async open(
    @Param('token') token: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const claims = this.signed.verify(token);
    if (!claims || !StorageService.isPrivateKey(claims.key)) throw new NotFoundException(NOT_FOUND);
    if (claims.userId && claims.userId !== user.id) throw new NotFoundException(NOT_FOUND);

    const file = await this.storage.open(claims.key);
    if (!file) throw new NotFoundException(NOT_FOUND);

    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    return new StreamableFile(file.stream, {
      type: claims.contentType,
      length: file.size,
      disposition: `${INLINE_TYPES.has(claims.contentType) ? 'inline' : 'attachment'}; filename="${safeFilename(claims.filename)}"`,
    });
  }
}