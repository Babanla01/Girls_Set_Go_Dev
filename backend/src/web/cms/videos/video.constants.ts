/**
 * video.constants.ts
 * ---------------------------------------------------------------------------
 * The numbers and small helpers behind the Creative Studio video library.
 */
import { CmsVideoCategory } from '@prisma/client';

import { API_BASE } from '../media/media.constants';

/** The largest uploaded video file (300 MB). Longer or heavier videos belong on YouTube or Vimeo. */
export const VIDEO_MAX_BYTES = 300 * 1024 * 1024;
/** The longest video accepted (4 hours). */
export const VIDEO_MAX_SECONDS = 4 * 60 * 60;
export const CAPTIONS_MAX_BYTES = 600_000;
export const TRANSCRIPT_MAX_BYTES = 300_000;

/** A video thumbnail must be at least 1280 x 720 and 16:9 (within 2%). */
export const THUMB_MIN_WIDTH = 1280;
export const THUMB_MIN_HEIGHT = 720;
export const THUMB_RATIO = 16 / 9;
export const THUMB_RATIO_TOLERANCE = 0.02;

export const MAX_PEOPLE_IN_VIDEO = 12;
export const MAX_EXTRA_TAGS = 3;

/** The categories: what they are called on screen and in addresses (/studio?category=ai-robotics). */
export const VIDEO_CATEGORIES: Record<CmsVideoCategory, { slug: string; label: string }> = {
  UI_UX_PROJECTS: { slug: 'ui-ux-projects', label: 'UI/UX Projects' },
  AI_ROBOTICS: { slug: 'ai-robotics', label: 'AI & Robotics' },
  STUDENT_STORIES: { slug: 'student-stories', label: 'Student Stories' },
  BEHIND_THE_SCENES: { slug: 'behind-the-scenes', label: 'Behind the Scenes' },
};

export const categoryFromSlug = (slug: string): CmsVideoCategory | null =>
  (Object.entries(VIDEO_CATEGORIES).find(([, value]) => value.slug === slug)?.[0] as CmsVideoCategory | undefined) ?? null;

export const categoryView = (category: CmsVideoCategory) => ({ key: category, ...VIDEO_CATEGORIES[category] });

/** The video file types accepted, and the file ending each one gets. */
export const VIDEO_CONTENT_TYPES: Record<string, 'mp4' | 'mov'> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

/** Uploaded videos are kept apart from pictures, under their own folder. */
export const VIDEO_FILE_PREFIX = 'video-files';
export const videoFileKey = (slug: string, extension: string) => `${VIDEO_FILE_PREFIX}/${slug}.${extension}`;

/** The public address of an uploaded video. The version is part of it, so a replaced file is fetched fresh. */
export const videoFileUrl = (slug: string, extension: string, version: number) =>
  `${API_BASE}/files/video/${slug}.${extension}?v=${version}`;

export const captionsUrl = (slug: string) => `${API_BASE}/public/videos/${slug}/captions.vtt`;

/**
 * The website pages that show videos, asked to refresh when a video is published or taken offline.
 * Adjust to the real addresses of your website.
 */
export const VIDEO_PAGES_TO_REFRESH = ['/', '/studio', '/cohort'];