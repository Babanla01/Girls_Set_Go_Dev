/**
 * banners.view.ts
 * ---------------------------------------------------------------------------
 * What a banner slide looks like.
 *
 *   state   DRAFT      not published
 *           SCHEDULED  published, but its start time has not come yet
 *           LIVE       published and inside its schedule: visitors see it
 *           EXPIRED    published, but its end time has passed
 */
import type { CmsBannerPage, Prisma } from '@prisma/client';

import { publicImageSelect, toPublicImage } from '../media/media.view';
import { videoFileUrl } from '../videos/video.constants';
import { BANNER_IMAGE_FOLDERS, BANNER_IMAGE_MIN_WIDTH, BANNER_PAGES } from './banner.constants';

export const slideSelect = {
  id: true,
  title: true,
  tagline: true,
  mediaType: true,
  imageAssetId: true,
  videoId: true,
  status: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  updatedAt: true,
  image: { select: { id: true, folder: true, ...publicImageSelect } },
  video: {
    select: { id: true, slug: true, title: true, status: true, source: true, fileKey: true, contentType: true, fileVersion: true, width: true, height: true, durationSeconds: true },
  },
  placements: { select: { page: true, position: true }, orderBy: [{ page: 'asc' as const }] },
} satisfies Prisma.CmsBannerSlideSelect;

type SlideRow = Prisma.CmsBannerSlideGetPayload<{ select: typeof slideSelect }>;

export type SlideState = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'EXPIRED';

export function stateOf(row: { status: string; startsAt: Date | null; endsAt: Date | null }, now: Date): SlideState {
  if (row.status !== 'PUBLISHED') return 'DRAFT';
  if (row.startsAt && row.startsAt > now) return 'SCHEDULED';
  if (row.endsAt && row.endsAt <= now) return 'EXPIRED';
  return 'LIVE';
}

/** What is still missing before the slide may be published (an empty list means it is ready). */
export function slideProblems(slide: Pick<SlideRow, 'mediaType' | 'image' | 'video' | 'placements' | 'startsAt' | 'endsAt'>): string[] {
  const problems: string[] = [];

  if (!BANNER_IMAGE_FOLDERS.includes(slide.image.folder)) {
    problems.push('The banner picture must come from the Banners or Site folder of the media library.');
  } else if (slide.image.width < BANNER_IMAGE_MIN_WIDTH || slide.image.width < slide.image.height) {
    problems.push(`The banner picture must be landscape and at least ${BANNER_IMAGE_MIN_WIDTH} px wide.`);
  }

  if (slide.mediaType === 'VIDEO') {
    if (!slide.video) problems.push('Choose the video for this slide.');
    else if (slide.video.source !== 'UPLOAD' || !slide.video.fileKey) problems.push('Only an uploaded video can play as a banner (muted loop).');
    else if (slide.video.status !== 'PUBLISHED') problems.push('The video must be published first.');
  }

  if (slide.placements.length === 0) problems.push('Choose at least one page for this slide.');
  if (slide.startsAt && slide.endsAt && slide.endsAt <= slide.startsAt) problems.push('The end time must be after the start time.');
  return problems;
}

export function toSlideView(row: SlideRow, now: Date) {
  const problems = slideProblems(row);
  return {
    id: row.id,
    title: row.title,
    tagline: row.tagline,
    mediaType: row.mediaType,
    image: { assetId: row.image.id, ...toPublicImage(row.image) },
    video: row.video
      ? { id: row.video.id, slug: row.video.slug, title: row.video.title, published: row.video.status === 'PUBLISHED', durationSeconds: row.video.durationSeconds }
      : null,
    state: stateOf(row, now),
    status: row.status,
    schedule: { startsAt: row.startsAt, endsAt: row.endsAt },
    placements: row.placements.map((placement) => ({
      page: placement.page,
      label: BANNER_PAGES[placement.page as CmsBannerPage].label,
      position: placement.position,
    })),
    canPublish: problems.length === 0,
    problems,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The slide as the public website draws it. */
export function toPublicSlide(row: SlideRow) {
  const video = row.mediaType === 'VIDEO' && row.video?.fileKey
    ? {
        url: videoFileUrl(row.video.slug, row.video.fileKey.split('.').pop() ?? 'mp4', row.video.fileVersion),
        contentType: row.video.contentType ?? 'video/mp4',
        width: row.video.width,
        height: row.video.height,
        durationSeconds: row.video.durationSeconds,
        // Always muted and looping, with the picture below shown until it loads.
        muted: true,
        loop: true,
      }
    : null;

  return {
    id: row.id,
    title: row.title,
    tagline: row.tagline || null,
    media: { type: row.mediaType, image: toPublicImage(row.image), video },
  };
}