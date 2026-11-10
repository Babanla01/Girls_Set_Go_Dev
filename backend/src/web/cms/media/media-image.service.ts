/**
 * media-image.service.ts
 * ---------------------------------------------------------------------------
 * Everything that looks inside a picture. Uses the "sharp" library.
 *
 * What happens to an uploaded picture:
 *   1. It must REALLY be a JPG, PNG or WebP picture (the file's own contents are
 *      checked - a renamed document or a script is refused, whatever its name).
 *   2. It must be between 200 and 8000 pixels on each side.
 *   3. It is turned upright according to its camera rotation, and then ALL
 *      hidden camera data is removed - above all the GPS location, which photos of
 *      girls must never carry onto a public website.
 *   4. A fingerprint (SHA-256) is taken, to know if a replacement is identical.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

import {
  FORMAT_INFO,
  MEDIA_INPUT_PIXEL_LIMIT,
  MEDIA_MAX_SIDE,
  MEDIA_MIN_SIDE,
  MediaFormat,
} from './media.constants';

export interface ProcessedImage {
  buffer: Buffer;
  format: MediaFormat;
  contentType: string;
  extension: string;
  width: number;
  height: number;
  sizeBytes: number;
  checksum: string;
}

const NOT_A_PICTURE = 'This file is not a readable picture. Please upload a JPG, PNG or WebP image.';

@Injectable()
export class MediaImageService {
  /** Checks a picture and returns the cleaned-up version to store. Throws a 400 with a clear message if it is not acceptable. */
  async process(input: Buffer): Promise<ProcessedImage> {
    let format: MediaFormat;
    try {
      const detected = (await sharp(input, { limitInputPixels: MEDIA_INPUT_PIXEL_LIMIT }).metadata()).format;
      if (detected !== 'jpeg' && detected !== 'png' && detected !== 'webp') throw new Error('unsupported');
      format = detected;
    } catch {
      throw new BadRequestException(NOT_A_PICTURE);
    }

    try {
      const upright = sharp(input, { limitInputPixels: MEDIA_INPUT_PIXEL_LIMIT }).rotate(); // sharp drops hidden metadata by default
      const encoded =
        format === 'jpeg'
          ? upright.jpeg({ quality: 92, mozjpeg: true })
          : format === 'png'
            ? upright.png({ compressionLevel: 9 })
            : upright.webp({ quality: 92 });
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });

      if (info.width < MEDIA_MIN_SIDE || info.height < MEDIA_MIN_SIDE) {
        throw new BadRequestException(
          `The picture is too small (${info.width} × ${info.height} px). It must be at least ${MEDIA_MIN_SIDE} × ${MEDIA_MIN_SIDE} px.`,
        );
      }
      if (info.width > MEDIA_MAX_SIDE || info.height > MEDIA_MAX_SIDE) {
        throw new BadRequestException(
          `The picture is too large (${info.width} × ${info.height} px). The longest side must be at most ${MEDIA_MAX_SIDE} px.`,
        );
      }

      return {
        buffer: data,
        format,
        contentType: FORMAT_INFO[format].contentType,
        extension: FORMAT_INFO[format].extension,
        width: info.width,
        height: info.height,
        sizeBytes: data.length,
        checksum: createHash('sha256').update(data).digest('hex'),
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(NOT_A_PICTURE);
    }
  }

  /** A smaller copy (as WebP) for fast pages. Never enlarges a picture. */
  variant(original: Buffer, width: number): Promise<Buffer> {
    return sharp(original, { limitInputPixels: MEDIA_INPUT_PIXEL_LIMIT })
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  }
}