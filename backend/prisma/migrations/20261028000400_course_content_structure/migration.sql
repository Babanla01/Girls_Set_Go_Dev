-- Batch 2A: course content structure.
--
--   course_contents  one EDITABLE copy of a course: the course's master template,
--                    or one cohort's own copy (made from the template)
--   course_weeks     the weeks of a copy, in order
--   course_lessons   the lessons of a week, in order
--   lesson_blocks    the blocks of a lesson (text, video, activity, steps, callout, resource)
--
-- Everything here is the DRAFT (working) content. Publishing and version history
-- arrive in Batch 2B. Deleting a week deletes its lessons and blocks (cascade).
-- Written by hand because it contains rules Prisma cannot express (CHECKs and a
-- partial unique index); the table and index names follow Prisma's conventions.

CREATE TYPE "ContentKind" AS ENUM ('TEMPLATE', 'COHORT_COPY');
CREATE TYPE "BlockType"   AS ENUM ('TEXT', 'VIDEO', 'ACTIVITY', 'STEPS', 'CALLOUT', 'RESOURCE');

-- ---------------------------------------------------------------------------
-- course_contents
-- ---------------------------------------------------------------------------
CREATE TABLE "course_contents" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "kind"                  "ContentKind" NOT NULL,
  "course_id"             UUID         NOT NULL,
  "cohort_id"             UUID,
  "base_template_version" INTEGER      NOT NULL DEFAULT 0,
  "draft_revision"        INTEGER      NOT NULL DEFAULT 0,
  "last_edited_by_id"     UUID,
  "last_edited_at"        TIMESTAMPTZ(3),
  "created_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "course_contents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "course_contents_cohort_id_key" ON "course_contents"("cohort_id");
CREATE INDEX "course_contents_course_id_idx" ON "course_contents"("course_id");

ALTER TABLE "course_contents"
  ADD CONSTRAINT "course_contents_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "course_contents_cohort_id_fkey"
    FOREIGN KEY ("cohort_id") REFERENCES "cohorts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "course_contents_last_edited_by_id_fkey"
    FOREIGN KEY ("last_edited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- HAND-WRITTEN rules:
--  * a course has at most ONE master template;
--  * a template belongs to no cohort, and a cohort copy always belongs to one.
CREATE UNIQUE INDEX "course_contents_one_template_per_course"
  ON "course_contents"("course_id") WHERE "kind" = 'TEMPLATE';
ALTER TABLE "course_contents"
  ADD CONSTRAINT "course_contents_kind_cohort_check"
    CHECK (("kind" = 'TEMPLATE') = ("cohort_id" IS NULL));

-- ---------------------------------------------------------------------------
-- course_weeks
-- ---------------------------------------------------------------------------
CREATE TABLE "course_weeks" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "content_id" UUID         NOT NULL,
  "position"   INTEGER      NOT NULL,
  "title"      VARCHAR(150) NOT NULL,
  "summary"    VARCHAR(1000),
  "origin_id"  UUID,
  "revision"   INTEGER      NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "course_weeks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_weeks_position_check" CHECK ("position" >= 1),
  CONSTRAINT "course_weeks_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "course_weeks_title_check"    CHECK (btrim("title") <> '')
);

CREATE UNIQUE INDEX "course_weeks_id_content_id_key" ON "course_weeks"("id", "content_id");
CREATE INDEX "course_weeks_content_id_position_idx" ON "course_weeks"("content_id", "position");

ALTER TABLE "course_weeks"
  ADD CONSTRAINT "course_weeks_content_id_fkey"
    FOREIGN KEY ("content_id") REFERENCES "course_contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- course_lessons  (the composite link to the week guarantees that a lesson and
-- its week always belong to the SAME course copy)
-- ---------------------------------------------------------------------------
CREATE TABLE "course_lessons" (
  "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
  "content_id"        UUID         NOT NULL,
  "week_id"           UUID         NOT NULL,
  "position"          INTEGER      NOT NULL,
  "title"             VARCHAR(150) NOT NULL,
  "summary"           VARCHAR(1000),
  "estimated_minutes" INTEGER,
  "origin_id"         UUID,
  "revision"          INTEGER      NOT NULL DEFAULT 1,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "course_lessons_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_lessons_position_check" CHECK ("position" >= 1),
  CONSTRAINT "course_lessons_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "course_lessons_title_check"    CHECK (btrim("title") <> ''),
  CONSTRAINT "course_lessons_minutes_check"  CHECK ("estimated_minutes" IS NULL OR "estimated_minutes" BETWEEN 1 AND 600)
);

CREATE UNIQUE INDEX "course_lessons_id_content_id_key" ON "course_lessons"("id", "content_id");
CREATE INDEX "course_lessons_week_id_position_idx" ON "course_lessons"("week_id", "position");
CREATE INDEX "course_lessons_content_id_idx" ON "course_lessons"("content_id");

ALTER TABLE "course_lessons"
  ADD CONSTRAINT "course_lessons_week_id_content_id_fkey"
    FOREIGN KEY ("week_id", "content_id") REFERENCES "course_weeks"("id", "content_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- lesson_blocks
-- ---------------------------------------------------------------------------
CREATE TABLE "lesson_blocks" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "content_id"      UUID         NOT NULL,
  "lesson_id"       UUID         NOT NULL,
  "position"        INTEGER      NOT NULL,
  "type"            "BlockType"  NOT NULL,
  "instructor_only" BOOLEAN      NOT NULL DEFAULT false,
  "data"            JSONB        NOT NULL,
  "origin_id"       UUID,
  "revision"        INTEGER      NOT NULL DEFAULT 1,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "lesson_blocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lesson_blocks_position_check" CHECK ("position" >= 1),
  CONSTRAINT "lesson_blocks_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "lesson_blocks_data_check"     CHECK (jsonb_typeof("data") = 'object')
);

CREATE INDEX "lesson_blocks_lesson_id_position_idx" ON "lesson_blocks"("lesson_id", "position");
CREATE INDEX "lesson_blocks_content_id_idx" ON "lesson_blocks"("content_id");

ALTER TABLE "lesson_blocks"
  ADD CONSTRAINT "lesson_blocks_lesson_id_content_id_fkey"
    FOREIGN KEY ("lesson_id", "content_id") REFERENCES "course_lessons"("id", "content_id") ON DELETE CASCADE ON UPDATE CASCADE;
