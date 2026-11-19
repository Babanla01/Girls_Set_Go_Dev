/**
 * byte-range.ts
 * ---------------------------------------------------------------------------
 * Sending a video so that a viewer can SKIP AHEAD. Browsers ask for a slice of
 * the file ("bytes=1000000-") instead of the whole thing; the server answers
 * with just that slice (status 206) and says how big the whole file is. Without
 * this, a video would not be seekable and would download in full before playing.
 */
import { NotFoundException, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { StorageService } from '../../../platform/storage/storage.service';

export type RangeResult = { start: number; end: number } | 'invalid' | null;

/**
 * Understands a single "Range: bytes=a-b" header. Returns null when there is no (usable) range
 * - send the whole file - and "invalid" when the range lies outside the file (answer 416).
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // several ranges, or another unit: just send the whole file
  const [, from, to] = match;

  if (from === '' && to === '') return 'invalid';
  if (from === '') {
    const last = Number(to); // "the last N bytes"
    if (last === 0) return 'invalid';
    return { start: Math.max(0, size - last), end: size - 1 };
  }

  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

export interface SendFileOptions {
  key: string;
  contentType: string;
  cacheControl: string;
  etag?: string;
}

/** Streams a stored file, honouring byte ranges. Use it with `@Res({ passthrough: true })`. */
export async function sendStoredFile(
  storage: StorageService,
  req: Request,
  res: Response,
  options: SendFileOptions,
): Promise<StreamableFile | undefined> {
  const size = await storage.size(options.key);
  if (size === null) throw new NotFoundException('Video not found.');

  res.set({
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...(options.etag ? { ETag: options.etag } : {}),
  });

  if (options.etag && req.headers['if-none-match'] === options.etag && !req.headers.range) {
    res.status(304);
    return undefined;
  }

  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.status(416);
    res.set('Content-Range', `bytes */${size}`);
    return undefined;
  }

  const file = await storage.open(options.key, range ?? undefined);
  if (!file) throw new NotFoundException('Video not found.');

  if (range) {
    res.status(206);
    res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    return new StreamableFile(file.stream, { type: options.contentType, length: range.end - range.start + 1, disposition: 'inline' });
  }
  return new StreamableFile(file.stream, { type: options.contentType, length: file.size, disposition: 'inline' });
}