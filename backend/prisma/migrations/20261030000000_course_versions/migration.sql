-- Batch 2B-1: publishing and version history for course content.
--
--   course_versions   every PUBLISHED version of a course copy: a frozen snapshot of
--                     all its weeks, lessons and blocks, with who published it, their
--                     role, when, and a list of what changed. Versions are never
--                     edited or deleted ("nothing is ever overwritten").
--   course_contents   gets three columns that say which version is LIVE.
--   edited_by_id      on weeks, lessons and blocks: who last changed each item. A
--                     database trigger fills it in, so no application code can forget.
--
-- Written by hand (triggers and CHECK rules); names follow Prisma's conventions.

CREATE TYPE "VersionSource" AS ENUM ('PUBLISH', 'RESTORE');

-- ---------------------------------------------------------------------------
-- course_versions
-- ---------------------------------------------------------------------------
CREATE TABLE "course_versions" (
  "id"                   UUID           NOT NULL DEFAULT gen_random_uuid(),
  "content_id"           UUID           NOT NULL,
  "number"               INTEGER        NOT NULL,
  "source"               "VersionSource" NOT NULL,
  "summary"              VARCHAR(500)   NOT NULL,
  "snapshot"             JSONB          NOT NULL,
  "changes"              JSONB          NOT NULL,
  "week_count"           INTEGER        NOT NULL,
  "lesson_count"         INTEGER        NOT NULL,
  "block_count"          INTEGER        NOT NULL,
  "published_by_id"      UUID           NOT NULL,
  "published_by_role"    "Role"         NOT NULL,
  "restored_from_number" INTEGER,
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "course_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_versions_number_check"   CHECK ("number" >= 1),
  CONSTRAINT "course_versions_counts_check"   CHECK ("week_count" >= 0 AND "lesson_count" >= 0 AND "block_count" >= 0),
  CONSTRAINT "course_versions_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object'),
  CONSTRAINT "course_versions_changes_check"  CHECK (jsonb_typeof("changes") = 'array'),
  CONSTRAINT "course_versions_restore_check"  CHECK (("source" = 'RESTORE') = ("restored_from_number" IS NOT NULL))
);

CREATE UNIQUE INDEX "course_versions_content_id_number_key" ON "course_versions"("content_id", "number");

ALTER TABLE "course_versions"
  ADD CONSTRAINT "course_versions_content_id_fkey"
    FOREIGN KEY ("content_id") REFERENCES "course_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- HAND-WRITTEN rule: a saved version can never be changed or removed.
CREATE FUNCTION "course_versions_refuse_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'course_versions is append-only: a saved version cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "course_versions_immutable"
  BEFORE UPDATE OR DELETE ON "course_versions"
  FOR EACH ROW EXECUTE FUNCTION "course_versions_refuse_change"();

-- ---------------------------------------------------------------------------
-- course_contents: which version is live
--   published_version         the live version number (empty = nothing published yet)
--   published_at              when it went live
--   published_draft_revision  the draft revision at that moment; if the draft revision
--                             is different now, there may be unpublished changes
-- ---------------------------------------------------------------------------
ALTER TABLE "course_contents"
  ADD COLUMN "published_version"        INTEGER,
  ADD COLUMN "published_at"             TIMESTAMPTZ(3),
  ADD COLUMN "published_draft_revision" INTEGER;

ALTER TABLE "course_contents"
  ADD CONSTRAINT "course_contents_published_check"
    CHECK (("published_version" IS NULL) = ("published_at" IS NULL)
       AND ("published_version" IS NULL) = ("published_draft_revision" IS NULL));

-- ---------------------------------------------------------------------------
-- Who last changed each item. The application announces the signed-in person at
-- the start of every edit ("app.user_id"); this trigger stamps it on each
-- inserted or updated row. Rows written outside an edit (for example a copy made
-- from a template) keep an empty editor.
-- ---------------------------------------------------------------------------
ALTER TABLE "course_weeks"   ADD COLUMN "edited_by_id" UUID;
ALTER TABLE "course_lessons" ADD COLUMN "edited_by_id" UUID;
ALTER TABLE "lesson_blocks"  ADD COLUMN "edited_by_id" UUID;

CREATE FUNCTION "course_content_stamp_editor"() RETURNS trigger AS $$
DECLARE
  editor text := current_setting('app.user_id', true);
BEGIN
  IF editor IS NOT NULL AND editor <> '' THEN
    NEW."edited_by_id" := editor::uuid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "course_weeks_stamp_editor"
  BEFORE INSERT OR UPDATE ON "course_weeks"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
CREATE TRIGGER "course_lessons_stamp_editor"
  BEFORE INSERT OR UPDATE ON "course_lessons"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
CREATE TRIGGER "lesson_blocks_stamp_editor"
  BEFORE INSERT OR UPDATE ON "lesson_blocks"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
