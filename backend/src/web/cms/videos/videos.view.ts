/**
 * videos.view.ts
 * ---------------------------------------------------------------------------
 * What a video looks like: the admin views (with "what is missing to publish it")
 * and the public views for the website.
 *
 * A video can be PUBLISHED only when it is complete (and the database refuses
 * otherwise): its file or embed link, a length, English captions, a 16:9
 * thumbnail of at least 1280 x 720 from the Videos folder, and - when learners
 * appear - the guardian consent with the date it was signed.
 */
import type { CmsVideoCategory, CmsVideoSource, Prisma } from '@prisma/client';

import { formatCalendarDate } from '../../../catalog/catalog.util';
import { publicImageSelect, toPublicImage } from '../media/media.view';
import { embedUrl, ExternalSource, watchUrl } from './video-url';
import {
  captionsUrl,
  categoryView,
  THUMB_MIN_HEIGHT,
  THUMB_MIN_WIDTH,
  THUMB_RATIO,
  THUMB_RATIO_TOLERANCE,
  videoFileUrl,
} from './video.constants';

const thumbnailSelect = { select: { id: true, folder: true, ...publicImageSelect } };

export const videoListSelect = {
  id: true,
  slug: true,
  title: true,
  source: true,
  category: true,
  alsoTagged: true,
  durationSeconds: true,
  status: true,
  featured: true,
  showOnHome: true,
  showOnStudio: true,
  showOnShowcase: true,
  displayOrder: true,
  postedOn: true,
  publishedAt: true,
  captionsUpdatedAt: true,
  transcriptUpdatedAt: true,
  showsLearners: true,
  consentSignedOn: true,
  fileKey: true,
  externalId: true,
  width: true,
  height: true,
  createdAt: true,
  updatedAt: true,
  thumbnail: thumbnailSelect,
} satisfies Prisma.CmsVideoSelect;

export const videoDetailSelect = {
  ...videoListSelect,
  hoverDescription: true,
  contentType: true,
  sizeBytes: true,
  fileVersion: true,
  peopleInVideo: true,
  thumbnailAssetId: true,
  captionsVtt: true,
  transcript: true,
} satisfies Prisma.CmsVideoSelect;

/** What the public website needs to draw a video card. */
export const videoCardSelect = {
  id: true,
  slug: true,
  title: true,
  source: true,
  category: true,
  alsoTagged: true,
  hoverDescription: true,
  durationSeconds: true,
  featured: true,
  postedOn: true,
  fileKey: true,
  contentType: true,
  fileVersion: true,
  width: true,
  height: true,
  externalId: true,
  showsLearners: true,
  peopleInVideo: true,
  captionsUpdatedAt: true,
  transcriptUpdatedAt: true,
  thumbnail: { select: publicImageSelect },
} satisfies Prisma.CmsVideoSelect;

export const videoPublicDetailSelect = { ...videoCardSelect, transcript: true } satisfies Prisma.CmsVideoSelect;

type ListRow = Prisma.CmsVideoGetPayload<{ select: typeof videoListSelect }>;
type DetailRow = Prisma.CmsVideoGetPayload<{ select: typeof videoDetailSelect }>;
type CardRow = Prisma.CmsVideoGetPayload<{ select: typeof videoCardSelect }>;
type PublicDetailRow = Prisma.CmsVideoGetPayload<{ select: typeof videoPublicDetailSelect }>;

// --------------------------------------------------------------- completeness

export interface VideoFacts {
  source: CmsVideoSource;
  fileKey: string | null;
  externalId: string | null;
  durationSeconds: number;
  captionsPresent: boolean;
  thumbnail: { folder: string; width: number; height: number } | null;
  showsLearners: boolean;
  consentSignedOn: Date | null;
}

/** What is still missing before the video may be published (an empty list means it is ready). `today` is "YYYY-MM-DD". */
export function videoProblems(video: VideoFacts, today: string): string[] {
  const problems: string[] = [];

  if (video.source === 'UPLOAD' && !video.fileKey) problems.push('Upload the video file (MP4 or MOV).');
  if (video.source !== 'UPLOAD' && !video.externalId) problems.push('The video link is missing.');
  if (video.durationSeconds <= 0) problems.push('The length of the video is needed.');
  if (!video.captionsPresent) problems.push('English captions (a .vtt file) are required.');

  if (!video.thumbnail) {
    problems.push('A thumbnail is required.');
  } else {
    const { folder, width, height } = video.thumbnail;
    if (folder !== 'VIDEOS') problems.push('The thumbnail must come from the Videos folder of the media library.');
    if (width < THUMB_MIN_WIDTH || height < THUMB_MIN_HEIGHT) {
      problems.push(`The thumbnail must be at least ${THUMB_MIN_WIDTH} × ${THUMB_MIN_HEIGHT} px.`);
    } else if (Math.abs(width / height - THUMB_RATIO) > THUMB_RATIO * THUMB_RATIO_TOLERANCE) {
      problems.push('The thumbnail must be 16:9 (widescreen).');
    }
  }

  if (video.showsLearners) {
    if (!video.consentSignedOn) {
      problems.push('Guardian consent must be recorded, with the date it was signed, for a video that shows learners.');
    } else if (formatCalendarDate(video.consentSignedOn) > today) {
      problems.push('The consent date cannot be in the future.');
    }
  }
  return problems;
}

export const factsOf = (row: ListRow | DetailRow): VideoFacts => ({
  source: row.source,
  fileKey: row.fileKey,
  externalId: row.externalId,
  durationSeconds: row.durationSeconds,
  captionsPresent: row.captionsUpdatedAt !== null,
  thumbnail: row.thumbnail ? { folder: row.thumbnail.folder, width: row.thumbnail.width, height: row.thumbnail.height } : null,
  showsLearners: row.showsLearners,
  consentSignedOn: row.consentSignedOn,
});

// ------------------------------------------------------------------- sources

function fileExtension(fileKey: string | null): string {
  return fileKey?.split('.').pop() ?? 'mp4';
}

/** Where the picture and sound come from, as the website needs it. */
export function sourceView(row: {
  source: CmsVideoSource;
  slug: string;
  fileKey: string | null;
  contentType: string | null;
  fileVersion: number;
  width: number | null;
  height: number | null;
  externalId: string | null;
}) {
  if (row.source === 'UPLOAD') {
    return {
      type: 'UPLOAD' as const,
      url: videoFileUrl(row.slug, fileExtension(row.fileKey), row.fileVersion),
      contentType: row.contentType ?? 'video/mp4',
      width: row.width,
      height: row.height,
    };
  }
  const external = row.source as ExternalSource;
  return {
    type: external,
    embedUrl: embedUrl(external, row.externalId ?? ''),
    watchUrl: watchUrl(external, row.externalId ?? ''),
  };
}

const dateText = (date: Date | null) => (date ? formatCalendarDate(date) : null);

// ---------------------------------------------------------------------- admin

export function toVideoSummary(row: ListRow, today: string) {
  const problems = videoProblems(factsOf(row), today);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    source: row.source,
    category: categoryView(row.category),
    alsoTagged: row.alsoTagged.map(categoryView),
    durationSeconds: row.durationSeconds,
    status: row.status,
    featured: row.featured,
    showOn: { home: row.showOnHome, studio: row.showOnStudio, showcase: row.showOnShowcase },
    displayOrder: row.displayOrder,
    postedOn: dateText(row.postedOn),
    publishedAt: row.publishedAt,
    hasCaptions: row.captionsUpdatedAt !== null,
    hasTranscript: row.transcriptUpdatedAt !== null,
    showsLearners: row.showsLearners,
    thumbnail: row.thumbnail ? toPublicImage(row.thumbnail) : null,
    canPublish: problems.length === 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toVideoDetail(row: DetailRow, today: string) {
  const problems = videoProblems(factsOf(row), today);
  return {
    ...toVideoSummary(row, today),
    hoverDescription: row.hoverDescription,
    thumbnailAssetId: row.thumbnailAssetId,
    file:
      row.source === 'UPLOAD'
        ? { present: row.fileKey !== null, contentType: row.contentType, sizeBytes: row.sizeBytes, width: row.width, height: row.height, version: row.fileVersion }
        : null,
    externalId: row.externalId,
    peopleInVideo: row.peopleInVideo,
    consentSignedOn: dateText(row.consentSignedOn),
    captions: { present: row.captionsUpdatedAt !== null, updatedAt: row.captionsUpdatedAt, text: row.captionsVtt },
    transcript: { present: row.transcriptUpdatedAt !== null, updatedAt: row.transcriptUpdatedAt, text: row.transcript },
    completeness: { canPublish: problems.length === 0, problems },
  };
}

// --------------------------------------------------------------------- public

/** A video card for the public website. */
export function toPublicVideoCard(row: CardRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    hoverDescription: row.hoverDescription || null,
    category: categoryView(row.category),
    alsoTagged: row.alsoTagged.map(categoryView),
    durationSeconds: row.durationSeconds,
    postedOn: dateText(row.postedOn),
    featured: row.featured,
    thumbnail: row.thumbnail ? toPublicImage(row.thumbnail) : null,
    source: sourceView(row),
    hasTranscript: row.transcriptUpdatedAt !== null,
  };
}

/** One video in full (the "lightbox"): the card plus captions, transcript and who appears in it. */
export function toPublicVideo(row: PublicDetailRow) {
  return {
    ...toPublicVideoCard(row),
    captions: row.captionsUpdatedAt ? { language: 'en', default: true, url: captionsUrl(row.slug) } : null,
    transcript: row.transcript,
    featuring: row.peopleInVideo,
    consentNote: row.showsLearners ? 'Shared with the consent of the learners’ guardians.' : null,
  };
}