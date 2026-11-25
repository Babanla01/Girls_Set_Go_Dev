/**
 * banner.constants.ts
 * ---------------------------------------------------------------------------
 * The pages that have a banner, and the rules for banner pictures.
 */
import { CmsBannerPage, CmsMediaFolder } from '@prisma/client';

/** What each banner page is called, and the website address to refresh when its slides change. Adjust the paths to your website. */
export const BANNER_PAGES: Record<CmsBannerPage, { label: string; path: string }> = {
  HOME: { label: 'Home', path: '/' },
  COHORT_SHOWCASE: { label: 'Cohort & showcase', path: '/cohort' },
  CREATIVE_STUDIO: { label: 'Creative Studio', path: '/studio' },
};

/** Banner pictures come from these folders of the media library. */
export const BANNER_IMAGE_FOLDERS: readonly CmsMediaFolder[] = [CmsMediaFolder.BANNERS, CmsMediaFolder.SITE];
/** A banner picture must be landscape and at least this wide. */
export const BANNER_IMAGE_MIN_WIDTH = 1200;