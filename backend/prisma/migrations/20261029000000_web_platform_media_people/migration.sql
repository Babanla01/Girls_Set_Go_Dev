-- WEB account, batch W1: shared platform settings, media library, public people profiles.
--
--   platform_settings   one row per setting an admin changed (defaults live in code)
--   cms_media_assets    pictures, each with a permanent key, required alt text, version
--   cms_media_usages    "this picture is used here" (blocks deleting a picture in use)
--   cms_people          public team / instructor profiles (draft until complete)
--
-- New tables only: no existing data is converted and no LMS table is changed.
-- The CHECK rules below are HAND-WRITTEN (Prisma cannot express them).

-- ---------------------------------------------------------------- enums
CREATE TYPE "CmsMediaFolder" AS ENUM ('BRAND', 'BANNERS', 'SITE', 'PEOPLE', 'PROJECTS', 'PRODUCTS', 'VIDEOS');
CREATE TYPE "CmsContentStatus" AS ENUM ('DRAFT', 'PUBLISHED');
CREATE TYPE "CmsPersonKind" AS ENUM ('TEAM', 'INSTRUCTOR', 'BOTH');

-- ------------------------------------------------------ platform_settings
CREATE TABLE "platform_settings" (
    "key"           VARCHAR(100)   NOT NULL,
    "value"         JSONB          NOT NULL,
    "updated_by_id" UUID,
    "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- ------------------------------------------------------- cms_media_assets
CREATE TABLE "cms_media_assets" (
    "id"                  UUID           NOT NULL DEFAULT gen_random_uuid(),
    "key"                 VARCHAR(150)   NOT NULL,
    "folder"              "CmsMediaFolder" NOT NULL,
    "title"               VARCHAR(120)   NOT NULL,
    "original_filename"   VARCHAR(200)   NOT NULL,
    "content_type"        VARCHAR(50)    NOT NULL,
    "size_bytes"          INTEGER        NOT NULL,
    "width"               INTEGER        NOT NULL,
    "height"              INTEGER        NOT NULL,
    "alt_text"            VARCHAR(250)   NOT NULL,
    "consent_recorded_at" TIMESTAMPTZ(3),
    "version"             INTEGER        NOT NULL DEFAULT 1,
    "checksum"            CHAR(64)       NOT NULL,
    "created_by_id"       UUID,
    "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "cms_media_assets_pkey" PRIMARY KEY ("id")
);

-- ------------------------------------------------------- cms_media_usages
CREATE TABLE "cms_media_usages" (
    "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
    "asset_id"    UUID           NOT NULL,
    "entity_type" VARCHAR(30)    NOT NULL,
    "entity_id"   VARCHAR(64)    NOT NULL,
    "field"       VARCHAR(60)    NOT NULL,
    "label"       VARCHAR(200)   NOT NULL,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cms_media_usages_pkey" PRIMARY KEY ("id")
);

-- --------------------------------------------------------------- cms_people
CREATE TABLE "cms_people" (
    "id"                   UUID             NOT NULL DEFAULT gen_random_uuid(),
    "full_name"            VARCHAR(120)     NOT NULL,
    "title"                VARCHAR(120)     NOT NULL DEFAULT '',
    "subtitle"             VARCHAR(120),
    "kind"                 "CmsPersonKind"  NOT NULL DEFAULT 'TEAM',
    "bio"                  VARCHAR(280)     NOT NULL DEFAULT '',
    "photo_asset_id"       UUID,
    "show_on_about"        BOOLEAN          NOT NULL DEFAULT true,
    "show_on_cohort"       BOOLEAN          NOT NULL DEFAULT false,
    "display_order"        INTEGER          NOT NULL DEFAULT 0,
    "status"               "CmsContentStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at"         TIMESTAMPTZ(3),
    "linked_instructor_id" UUID,
    "created_by_id"        UUID,
    "created_at"           TIMESTAMPTZ(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMPTZ(3)   NOT NULL,
    CONSTRAINT "cms_people_pkey" PRIMARY KEY ("id")
);

-- ------------------------------------------------------------------ indexes
CREATE UNIQUE INDEX "cms_media_assets_key_key" ON "cms_media_assets"("key");
CREATE INDEX "cms_media_assets_folder_created_at_idx" ON "cms_media_assets"("folder", "created_at");

CREATE UNIQUE INDEX "cms_media_usages_asset_id_entity_type_entity_id_field_key"
    ON "cms_media_usages"("asset_id", "entity_type", "entity_id", "field");
CREATE INDEX "cms_media_usages_entity_type_entity_id_idx" ON "cms_media_usages"("entity_type", "entity_id");

CREATE UNIQUE INDEX "cms_people_linked_instructor_id_key" ON "cms_people"("linked_instructor_id");
CREATE INDEX "cms_people_status_display_order_idx" ON "cms_people"("status", "display_order");

-- ------------------------------------------------------------- foreign keys
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_id_fkey"
    FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cms_media_assets" ADD CONSTRAINT "cms_media_assets_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cms_media_usages" ADD CONSTRAINT "cms_media_usages_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "cms_media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cms_people" ADD CONSTRAINT "cms_people_photo_asset_id_fkey"
    FOREIGN KEY ("photo_asset_id") REFERENCES "cms_media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cms_people" ADD CONSTRAINT "cms_people_linked_instructor_id_fkey"
    FOREIGN KEY ("linked_instructor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cms_people" ADD CONSTRAINT "cms_people_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN: rules the database itself enforces
-- ===========================================================================

-- A setting key looks like "site.applications_open" (lowercase words joined by dots).
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_key_format_chk"
    CHECK ("key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

-- A media key is "<folder>/<name>.<ext>" in lowercase, and its first part MUST be the folder.
ALTER TABLE "cms_media_assets" ADD CONSTRAINT "cms_media_assets_key_format_chk"
    CHECK ("key" ~ '^[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9_-]*\.[a-z0-9]{2,5}$'
       AND split_part("key", '/', 1) = lower("folder"::text));

ALTER TABLE "cms_media_assets" ADD CONSTRAINT "cms_media_assets_content_type_chk"
    CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp'));

ALTER TABLE "cms_media_assets" ADD CONSTRAINT "cms_media_assets_numbers_chk"
    CHECK ("size_bytes" > 0 AND "width" BETWEEN 1 AND 20000 AND "height" BETWEEN 1 AND 20000 AND "version" >= 1);

ALTER TABLE "cms_media_assets" ADD CONSTRAINT "cms_media_assets_text_chk"
    CHECK (length(btrim("title")) > 0 AND length(btrim("alt_text")) > 0 AND "checksum" ~ '^[a-f0-9]{64}$');

-- Pictures that show people (PEOPLE, PROJECTS folders) must have the consent confirmed.
ALTER TABLE "cms_media_assets" ADD CONSTRAINT "cms_media_assets_consent_chk"
    CHECK ("folder" NOT IN ('PEOPLE', 'PROJECTS') OR "consent_recorded_at" IS NOT NULL);

-- A profile needs a name; it can be PUBLISHED only with a title, a photo and a publish date.
ALTER TABLE "cms_people" ADD CONSTRAINT "cms_people_name_chk"
    CHECK (length(btrim("full_name")) > 0 AND "display_order" >= 0);

ALTER TABLE "cms_people" ADD CONSTRAINT "cms_people_published_complete_chk"
    CHECK ("status" <> 'PUBLISHED'
           OR (length(btrim("title")) > 0 AND "photo_asset_id" IS NOT NULL AND "published_at" IS NOT NULL));