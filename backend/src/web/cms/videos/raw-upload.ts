/**
 * raw-upload.ts
 * ---------------------------------------------------------------------------
 * Receiving files sent as the plain body of a request (no form wrapper):
 *
 *     PUT /api/v1/admin/videos/:id/file       Content-Type: video/mp4        <the video bytes>
 *     PUT /api/v1/admin/videos/:id/captions   Content-Type: text/vtt         <the file's text>
 *
 * A video is STREAMED to a temporary file as it arrives, so even a 300 MB upload
 * never sits in the server's memory, and the size limit stops it part-way instead
 * of after the whole thing has been sent.
 */
import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';

/** Streams the request body into a temporary file. The CALLER must delete the file when done. */
export async function streamToTempFile(req: Request, maxBytes: number): Promise<{ path: string; size: number }> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeException(`This file is too large (${Math.round(maxBytes / 1024 / 1024)} MB at most).`);
  }

  const path = join(tmpdir(), `gsg-upload-${randomBytes(8).toString('hex')}`);
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) callback(new PayloadTooLargeException(`This file is too large (${Math.round(maxBytes / 1024 / 1024)} MB at most).`));
      else callback(null, chunk);
    },
  });

  try {
    await pipeline(req, counter, createWriteStream(path));
  } catch (error) {
    await rm(path, { force: true });
    throw error instanceof HttpException ? error : new BadRequestException('The upload was interrupted. Please try again.');
  }

  if (size === 0) {
    await rm(path, { force: true });
    throw new BadRequestException('The upload was empty.');
  }
  return { path, size };
}

/** Reads a small text body (captions, transcript) as UTF-8. */
export async function readRawText(req: Request, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) throw new PayloadTooLargeException(`This file is too large (${Math.round(maxBytes / 1000)} KB at most).`);
      chunks.push(chunk);
    }
  } catch (error) {
    throw error instanceof HttpException ? error : new BadRequestException('The upload was interrupted. Please try again.');
  }

  if (size === 0) {
    throw new BadRequestException('Send the file text as the request body (for example Content-Type: text/vtt).');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BadRequestException('The file must be UTF-8 text.');
  }
}