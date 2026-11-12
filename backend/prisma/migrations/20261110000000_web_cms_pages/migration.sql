-- WEB account, batch W2: website pages with a draft, numbered published versions and history.
--
--   cms_pages          one row per page (path, title, the working-copy draft, which version is live)
--   cms_page_versions  frozen snapshots, one per publish; never changed or deleted
--
-- New tables only: no existing data is converted and no LMS table is changed.
-- The CHECK rules and the trigger below are HAND-WRITTEN (Prisma cannot express them).

-- ---------------------------------------------------------------- cms_pages
CREATE TABLE "cms_pages" (
    "id"                       UUID             NOT NULL DEFAULT gen_random_uuid(),
    "path"                     VARCHAR(120)     NOT NULL,
    "title"                    VARCHAR(150)     NOT NULL,
    "draft"                    JSONB            NOT NULL,
    "draft_revision"           INTEGER          NOT NULL DEFAULT 0,
    "last_edited_by_id"        UUID,
    "last_edited_at"           TIMESTAMPTZ(3),
    "status"                   "CmsContentStatus" NOT NULL DEFAULT 'DRAFT',
    "published_version"        INTEGER,
    "published_at"             TIMESTAMPTZ(3),
    "published_draft_revision" INTEGER,
    "created_by_id"            UUID,
    "created_at"               TIMESTAMPTZ(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMPTZ(3)   NOT NULL,
    CONSTRAINT "cms_pages_pkey" PRIMARY KEY ("id")
);

-- --------------------------------------------------------- cms_page_versions
CREATE TABLE "cms_page_versions" (
    "id"                UUID           NOT NULL DEFAULT gen_random_uuid(),
    "page_id"           UUID           NOT NULL,
    "number"            INTEGER        NOT NULL,
    "note"              VARCHAR(500),
    "summary"           VARCHAR(500)   NOT NULL,
    "snapshot"          JSONB          NOT NULL,
    "section_count"     INTEGER        NOT NULL,
    "published_by_id"   UUID           NOT NULL,
    "published_by_role" "Role"         NOT NULL,
    "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cms_page_versions_pkey" PRIMARY KEY ("id")
);

-- ------------------------------------------------------------------ indexes
CREATE UNIQUE INDEX "cms_pages_path_key" ON "cms_pages"("path");
CREATE INDEX "cms_pages_status_updated_at_idx" ON "cms_pages"("status", "updated_at");
CREATE UNIQUE INDEX "cms_page_versions_page_id_number_key" ON "cms_page_versions"("page_id", "number");

-- ------------------------------------------------------------- foreign keys
ALTER TABLE "cms_pages" ADD CONSTRAINT "cms_pages_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cms_pages" ADD CONSTRAINT "cms_pages_last_edited_by_id_fkey"
    FOREIGN KEY ("last_edited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cms_page_versions" ADD CONSTRAINT "cms_page_versions_page_id_fkey"
    FOREIGN KEY ("page_id") REFERENCES "cms_pages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cms_page_versions" ADD CONSTRAINT "cms_page_versions_published_by_id_fkey"
    FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN: rules the database itself enforces
-- ===========================================================================

-- A page path is "/" or lowercase words joined by dashes, in one or more levels ("/programs/tech-bootcamp").
ALTER TABLE "cms_pages" ADD CONSTRAINT "cms_pages_path_format_chk"
    CHECK ("path" ~ '^/$|^/[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$');

ALTER TABLE "cms_pages" ADD CONSTRAINT "cms_pages_basic_chk"
    CHECK (length(btrim("title")) > 0 AND "draft_revision" >= 0 AND jsonb_typeof("draft") = 'object');

-- LIVE means a version number and a publish time exist; NOT live means neither does.
ALTER TABLE "cms_pages" ADD CONSTRAINT "cms_pages_live_state_chk"
    CHECK (
      ("status" = 'PUBLISHED' AND "published_version" IS NOT NULL AND "published_version" >= 1 AND "published_at" IS NOT NULL)
      OR
      ("status" = 'DRAFT' AND "published_version" IS NULL AND "published_at" IS NULL)
    );

ALTER TABLE "cms_page_versions" ADD CONSTRAINT "cms_page_versions_numbers_chk"
    CHECK ("number" >= 1 AND "section_count" >= 0 AND jsonb_typeof("snapshot") = 'object');

-- A published version is history: it can never be edited or deleted.
CREATE FUNCTION "cms_page_versions_forbid_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Published page versions cannot be changed or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cms_page_versions_immutable"
    BEFORE UPDATE OR DELETE ON "cms_page_versions"
    FOR EACH ROW EXECUTE FUNCTION "cms_page_versions_forbid_change"();