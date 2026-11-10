/**
 * media.view.ts
 * ---------------------------------------------------------------------------
 * What a picture looks like in API responses. Every picture comes with its
 * public address (which includes the version), ready-made smaller sizes for
 * fast pages, and its alt text.
 */
import type { CmsMediaFolder, Prisma } from '@prisma/client';

import { LISTED_WIDTHS, publicMediaUrl } from './media.constants';

const baseFields = {
  id: true,
  key: true,
  folder: true,
  title: true,
  contentType: true,
  sizeBytes: true,
  width: true,
  height: true,
  altText: true,
  consentRecordedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const mediaListSelect = {
  ...baseFields,
  _count: { select: { usages: true } },
} satisfies Prisma.CmsMediaAssetSelect;

export const mediaDetailSelect = {
  ...baseFields,
  originalFilename: true,
  checksum: true,
  _count: { select: { usages: true } },
  usages: {
    orderBy: [{ label: 'asc' }, { field: 'asc' }],
    select: { entityType: true, entityId: true, field: true, label: true },
  },
} satisfies Prisma.CmsMediaAssetSelect;

/** The few fields needed to show a picture on a public page. */
export const publicImageSelect = {
  key: true,
  version: true,
  altText: true,
  width: true,
  height: true,
} satisfies Prisma.CmsMediaAssetSelect;

type ListRow = Prisma.CmsMediaAssetGetPayload<{ select: typeof mediaListSelect }>;
type DetailRow = Prisma.CmsMediaAssetGetPayload<{ select: typeof mediaDetailSelect }>;
type PublicRow = Prisma.CmsMediaAssetGetPayload<{ select: typeof publicImageSelect }>;

export interface ImageSize {
  width: number;
  url: string;
}

/** Ready-made smaller sizes, plus the original, for responsive images. */
function sizesOf(row: { key: string; version: number; width: number }): ImageSize[] {
  const smaller = LISTED_WIDTHS.filter((width) => width < row.width).map((width) => ({
    width,
    url: publicMediaUrl(row.key, row.version, width),
  }));
  return [...smaller, { width: row.width, url: publicMediaUrl(row.key, row.version) }];
}

/** A picture as the public website needs it. */
export function toPublicImage(row: PublicRow) {
  return {
    url: publicMediaUrl(row.key, row.version),
    alt: row.altText,
    width: row.width,
    height: row.height,
    sizes: sizesOf(row),
  };
}

export function toMediaView(row: ListRow) {
  return {
    id: row.id,
    key: row.key,
    folder: row.folder as CmsMediaFolder,
    title: row.title,
    url: publicMediaUrl(row.key, row.version),
    sizes: sizesOf(row),
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    altText: row.altText,
    consentRecorded: row.consentRecordedAt !== null,
    consentRecordedAt: row.consentRecordedAt,
    version: row.version,
    usedOnCount: row._count.usages,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toMediaDetail(row: DetailRow) {
  return {
    ...toMediaView(row),
    originalFilename: row.originalFilename,
    checksum: row.checksum,
    /** Everything that uses this picture. A picture in use cannot be deleted. */
    usedOn: row.usages.map((usage) => ({
      entityType: usage.entityType,
      entityId: usage.entityId,
      field: usage.field,
      label: usage.label,
    })),
  };
}