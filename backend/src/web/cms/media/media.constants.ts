/**
 * media.constants.ts
 * ---------------------------------------------------------------------------
 * The numbers and small helpers behind the media library, in one place.
 */
import { CmsMediaFolder } from '@prisma/client';

/** The largest picture file accepted (10 MB). */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** A picture must be at least this many pixels on each side... */
export const MEDIA_MIN_SIDE = 200;
/** ...and at most this many (a safety limit against huge images). */
export const MEDIA_MAX_SIDE = 8000;
/** Refuse to even open an image with more pixels than this (protects the server's memory). */
export const MEDIA_INPUT_PIXEL_LIMIT = 64_000_000;

/** Folders whose pictures show PEOPLE: the consent must be confirmed. */
export const CONSENT_FOLDERS: readonly CmsMediaFolder[] = [CmsMediaFolder.PEOPLE, CmsMediaFolder.PROJECTS];

/** A person's photo must be at least this big (square) to be published. */
export const PERSON_PHOTO_MIN_SIDE = 480;

/** Widths the website may ask for (a picture is resized to the nearest one above the request). */
export const VARIANT_WIDTHS = [240, 480, 720, 960, 1200, 1600, 2000] as const;
/** The ready-made sizes listed with every picture, for responsive images. */
export const LISTED_WIDTHS = [480, 960, 1600] as const;

export const FORMAT_INFO = {
  jpeg: { extension: 'jpg', contentType: 'image/jpeg' },
  png: { extension: 'png', contentType: 'image/png' },
  webp: { extension: 'webp', contentType: 'image/webp' },
} as const;
export type MediaFormat = keyof typeof FORMAT_INFO;

/** Where the API lives (it matches the global prefix and version in main.ts). */
export const API_BASE = '/api/v1';

/**
 * The public address of a picture. The version is part of the address, so when a
 * picture is replaced its address changes and browsers fetch the new one at once.
 */
export function publicMediaUrl(key: string, version: number, width?: number): string {
  return `${API_BASE}/files/public/${key}?v=${version}${width ? `&w=${width}` : ''}`;
}

/** "Queen Tané — CEO!" -> "queen-tane-ceo" (lowercase letters, digits and dashes). */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'image';
}

/** The smallest allowed width that is at least `requested` (or the largest allowed one). */
export function snapWidth(requested: number): number {
  return VARIANT_WIDTHS.find((width) => width >= requested) ?? VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
}