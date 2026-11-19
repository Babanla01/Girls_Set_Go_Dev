-- WEB account, batch W3: the Creative Studio video library and page banners.
--
--   cms_videos                      videos (uploaded or YouTube/Vimeo) with captions, thumbnail, consent
--   cms_banner_slides               banner slides: a photo or a muted looping video, with a schedule
--   cms_banner_slide_placements     which page shows which slide, and in what order
--
-- New tables only: no existing data is converted and no LMS table is changed.
-- The CHECK rules below are HAND-WRITTEN (Prisma cannot express them).

-- ---------------------------------------------------------------- enums
CREATE TYPE "CmsVideoSource"    AS ENUM ('UPLOAD', 'YOUTUBE', 'VIMEO');
CREATE TYPE "CmsVideoCategory"  AS ENUM ('UI_UX_PROJECTS', 'AI_ROBOTICS', 'STUDENT_STORIES', 'BEHIND_THE_SCENES');
CREATE TYPE "CmsBannerMediaType" AS ENUM ('PHOTO', 'VIDEO');
CREATE TYPE "CmsBannerPage"     AS ENUM ('HOME', 'COHORT_SHOWCASE', 'CREATIVE_STUDIO');

-- ---------------------------------------------------------------- cms_videos
CREATE TABLE "cms_videos" (
    "id"                    UUID               NOT NULL DEFAULT gen_random_uuid(),
    "slug"                  VARCHAR(80)        NOT NULL,
    "title"                 VARCHAR(120)       NOT NULL,
    "source"                "CmsVideoSource"   NOT NULL,
    "category"              "CmsVideoCategory" NOT NULL,
    "also_tagged"           "CmsVideoCategory"[] NOT NULL DEFAULT ARRAY[]::"CmsVideoCategory"[],
    "hover_description"     VARCHAR(120)       NOT NULL DEFAULT '',
    "file_key"              VARCHAR(120),
    "content_type"          VARCHAR(40),
    "size_bytes"            INTEGER,
    "file_version"          INTEGER            NOT NULL DEFAULT 1,
    "width"                 INTEGER,
    "height"                INTEGER,
    "external_id"           VARCHAR(60),
    "duration_seconds"      INTEGER            NOT NULL DEFAULT 0,
    "thumbnail_asset_id"    UUID,
    "captions_vtt"          TEXT,
    "captions_updated_at"   TIMESTAMPTZ(3),
    "transcript"            TEXT,
    "transcript_updated_at" TIMESTAMPTZ(3),
    "shows_learners"        BOOLEAN            NOT NULL DEFAULT false,
    "people_in_video"       TEXT[]             NOT NULL DEFAULT ARRAY[]::TEXT[],
    "consent_signed_on"     DATE,
    "show_on_home"          BOOLEAN            NOT NULL DEFAULT false,
    "show_on_studio"        BOOLEAN            NOT NULL DEFAULT true,
    "show_on_showcase"      BOOLEAN            NOT NULL DEFAULT false,
    "featured"              BOOLEAN            NOT NULL DEFAULT false,
    "display_order"         INTEGER            NOT NULL DEFAULT 0,
    "status"                "CmsContentStatus" NOT NULL DEFAULT 'DRAFT',
    "posted_on"             DATE,
    "published_at"          TIMESTAMPTZ(3),
    "created_by_id"         UUID,
    "created_at"            TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMPTZ(3)     NOT NULL,
    CONSTRAINT "cms_videos_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------- cms_banner_slides
CREATE TABLE "cms_banner_slides" (
    "id"             UUID                 NOT NULL DEFAULT gen_random_uuid(),
    "title"          VARCHAR(60)          NOT NULL,
    "tagline"        VARCHAR(160)         NOT NULL DEFAULT '',
    "media_type"     "CmsBannerMediaType" NOT NULL,
    "image_asset_id" UUID                 NOT NULL,
    "video_id"       UUID,
    "status"         "CmsContentStatus"   NOT NULL DEFAULT 'DRAFT',
    "starts_at"      TIMESTAMPTZ(3),
    "ends_at"        TIMESTAMPTZ(3),
    "created_by_id"  UUID,
    "created_at"     TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMPTZ(3)       NOT NULL,
    CONSTRAINT "cms_banner_slides_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cms_banner_slide_placements" (
    "slide_id" UUID            NOT NULL,
    "page"     "CmsBannerPage" NOT NULL,
    "position" INTEGER         NOT NULL DEFAULT 0,
    CONSTRAINT "cms_banner_slide_placements_pkey" PRIMARY KEY ("slide_id", "page")
);

-- ------------------------------------------------------------------ indexes
CREATE UNIQUE INDEX "cms_videos_slug_key" ON "cms_videos"("slug");
CREATE INDEX "cms_videos_status_category_display_order_idx" ON "cms_videos"("status", "category", "display_order");
CREATE INDEX "cms_videos_status_featured_idx" ON "cms_videos"("status", "featured");
CREATE INDEX "cms_banner_slides_status_idx" ON "cms_banner_slides"("status");
CREATE INDEX "cms_banner_slide_placements_page_position_idx" ON "cms_banner_slide_placements"("page", "position");

-- ------------------------------------------------------------- foreign keys
ALTER TABLE "cms_videos" ADD CONSTRAINT "cms_videos_thumbnail_asset_id_fkey"
    FOREIGN KEY ("thumbnail_asset_id") REFERENCES "cms_media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cms_videos" ADD CONSTRAINT "cms_videos_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cms_banner_slides" ADD CONSTRAINT "cms_banner_slides_image_asset_id_fkey"
    FOREIGN KEY ("image_asset_id") REFERENCES "cms_media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cms_banner_slides" ADD CONSTRAINT "cms_banner_slides_video_id_fkey"
    FOREIGN KEY ("video_id") REFERENCES "cms_videos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cms_banner_slides" ADD CONSTRAINT "cms_banner_slides_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cms_banner_slide_placements" ADD CONSTRAINT "cms_banner_slide_placements_slide_id_fkey"
    FOREIGN KEY ("slide_id") REFERENCES "cms_banner_slides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN: rules the database itself enforces
-- ===========================================================================

-- A video address word: lowercase words joined by dashes.
ALTER TABLE "cms_videos" ADD CONSTRAINT "cms_videos_slug_format_chk"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "cms_videos" ADD CONSTRAINT "cms_videos_basic_chk"
    CHECK (length(btrim("title")) > 0
       AND "duration_seconds" >= 0
       AND "display_order" >= 0
       AND "file_version" >= 1
       AND cardinality("people_in_video") <= 12
       AND NOT ("category" = ANY ("also_tagged")));

-- An uploaded video has no external id; an embedded one has an id and no file.
ALTER TABLE "cms_videos" ADD CONSTRAINT "cms_videos_source_chk"
    CHECK (("source" = 'UPLOAD' AND "external_id" IS NULL)
        OR ("source" <> 'UPLOAD' AND "file_key" IS NULL AND "external_id" IS NOT NULL));

-- A video can be PUBLISHED only when it is complete: a length, captions, a thumbnail, its file
-- (or embed id), and - when learners appear - the guardian consent with the date signed.
ALTER TABLE "cms_videos" ADD CONSTRAINT "cms_videos_published_complete_chk"
    CHECK ("status" <> 'PUBLISHED'
           OR ("duration_seconds" > 0
               AND "captions_vtt" IS NOT NULL
               AND "thumbnail_asset_id" IS NOT NULL
               AND ("source" <> 'UPLOAD' OR "file_key" IS NOT NULL)
               AND (NOT "shows_learners" OR "consent_signed_on" IS NOT NULL)
               AND "published_at" IS NOT NULL
               AND "posted_on" IS NOT NULL));

-- A banner slide: a title, a photo slide has no video and a video slide has one, and the
-- schedule makes sense (it ends after it starts).
ALTER TABLE "cms_banner_slides" ADD CONSTRAINT "cms_banner_slides_basic_chk"
    CHECK (length(btrim("title")) > 0
       AND (("media_type" = 'PHOTO' AND "video_id" IS NULL) OR ("media_type" = 'VIDEO' AND "video_id" IS NOT NULL))
       AND ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"));

ALTER TABLE "cms_banner_slide_placements" ADD CONSTRAINT "cms_banner_slide_placements_position_chk"
    CHECK ("position" >= 0);