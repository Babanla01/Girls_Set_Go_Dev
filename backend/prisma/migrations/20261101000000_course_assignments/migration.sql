-- Batch 4A: assignments and live class sessions inside the course content.
--
--   course_assignments     at most ONE assignment per week: the brief, what to include, the file
--                          types allowed, and the four-criterion rubric.
--   course_class_sessions  at most ONE live class per week (its date and time). The assignment's
--                          due date is worked out from it (3 days after class, 5 PM Central).
--
-- Both belong to a week of a course copy, so they are part of the DRAFT, are frozen into every
-- published version, and are replaced together with the rest when a version is restored.
-- A week and its assignment can never belong to different course copies (composite link).
-- Written by hand (CHECK rules and triggers); names follow Prisma's conventions.

-- ---------------------------------------------------------------------------
CREATE TABLE "course_assignments" (
  "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
  "content_id"         UUID           NOT NULL,
  "week_id"            UUID           NOT NULL,
  "title"              VARCHAR(150)   NOT NULL,
  "brief"              VARCHAR(5000)  NOT NULL,
  "includes"           TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],
  "success_evidence"   VARCHAR(1000),
  "expected_minutes"   INTEGER,
  "allowed_file_types" TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rubric"             JSONB          NOT NULL,
  "rubric_visible"     BOOLEAN        NOT NULL DEFAULT true,
  "origin_id"          UUID,
  "revision"           INTEGER        NOT NULL DEFAULT 1,
  "edited_by_id"       UUID,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "course_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_assignments_title_check"    CHECK (btrim("title") <> ''),
  CONSTRAINT "course_assignments_brief_check"    CHECK (btrim("brief") <> ''),
  CONSTRAINT "course_assignments_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "course_assignments_minutes_check"  CHECK ("expected_minutes" IS NULL OR "expected_minutes" BETWEEN 1 AND 600),
  CONSTRAINT "course_assignments_includes_check" CHECK (cardinality("includes") <= 10),
  CONSTRAINT "course_assignments_rubric_check"   CHECK (jsonb_typeof("rubric") = 'object'),
  -- Only these file types can ever be allowed (the same list the code uses).
  CONSTRAINT "course_assignments_file_types_check"
    CHECK ("allowed_file_types" <@ ARRAY['pdf','png','jpg','docx','pptx','zip','ino','py']::TEXT[])
);

CREATE UNIQUE INDEX "course_assignments_week_id_content_id_key" ON "course_assignments"("week_id", "content_id");
CREATE INDEX "course_assignments_content_id_idx" ON "course_assignments"("content_id");

ALTER TABLE "course_assignments"
  ADD CONSTRAINT "course_assignments_week_id_content_id_fkey"
    FOREIGN KEY ("week_id", "content_id") REFERENCES "course_weeks"("id", "content_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
CREATE TABLE "course_class_sessions" (
  "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
  "content_id"       UUID           NOT NULL,
  "week_id"          UUID           NOT NULL,
  "starts_at"        TIMESTAMPTZ(3) NOT NULL,
  "duration_minutes" INTEGER        NOT NULL,
  "join_url"         VARCHAR(2000),
  "notes"            VARCHAR(500),
  "origin_id"        UUID,
  "revision"         INTEGER        NOT NULL DEFAULT 1,
  "edited_by_id"     UUID,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "course_class_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_class_sessions_duration_check" CHECK ("duration_minutes" BETWEEN 15 AND 480),
  CONSTRAINT "course_class_sessions_revision_check" CHECK ("revision" >= 1)
);

CREATE UNIQUE INDEX "course_class_sessions_week_id_content_id_key" ON "course_class_sessions"("week_id", "content_id");
CREATE INDEX "course_class_sessions_content_id_idx" ON "course_class_sessions"("content_id");

ALTER TABLE "course_class_sessions"
  ADD CONSTRAINT "course_class_sessions_week_id_content_id_fkey"
    FOREIGN KEY ("week_id", "content_id") REFERENCES "course_weeks"("id", "content_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- "Last edited by": the same trigger the weeks, lessons and blocks use (Batch 2B-1).
-- ---------------------------------------------------------------------------
CREATE TRIGGER "course_assignments_stamp_editor"
  BEFORE INSERT OR UPDATE ON "course_assignments"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
CREATE TRIGGER "course_class_sessions_stamp_editor"
  BEFORE INSERT OR UPDATE ON "course_class_sessions"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
