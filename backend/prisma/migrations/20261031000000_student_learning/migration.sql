-- Batch 3: the student's learning progress.
--
--   lesson_progress  one row per (enrollment, lesson): when she completed it, and where she
--                    paused the video ("Resume from 03:12").
--   week_unlocks     the weeks that are OPEN for an enrollment because of progress, or because
--                    an instructor / admin opened one early. Once a week has been opened for a
--                    student it STAYS open, even if lessons are added to the course later.
--
-- IMPORTANT: lesson_id and week_id deliberately have NO foreign key. They are the permanent ids
-- of items in a PUBLISHED course version, which never change; the draft tables the editor
-- rewrites (restore / discard) can therefore never delete a student's progress.
-- Written by hand (CHECK rules); names follow Prisma's conventions.

CREATE TYPE "WeekUnlockSource" AS ENUM ('PROGRESS', 'EARLY_OPEN');

-- ---------------------------------------------------------------------------
CREATE TABLE "lesson_progress" (
  "id"                     UUID           NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id"          UUID           NOT NULL,
  "lesson_id"              UUID           NOT NULL,
  "completed_at"           TIMESTAMPTZ(3),
  "video_block_id"         UUID,
  "video_position_seconds" INTEGER,
  "created_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lesson_progress_video_position_check"
    CHECK ("video_position_seconds" IS NULL OR "video_position_seconds" BETWEEN 0 AND 86400),
  CONSTRAINT "lesson_progress_video_pair_check"
    CHECK (("video_block_id" IS NULL) = ("video_position_seconds" IS NULL))
);

CREATE UNIQUE INDEX "lesson_progress_enrollment_id_lesson_id_key" ON "lesson_progress"("enrollment_id", "lesson_id");
CREATE INDEX "lesson_progress_lesson_id_idx" ON "lesson_progress"("lesson_id");

ALTER TABLE "lesson_progress"
  ADD CONSTRAINT "lesson_progress_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
CREATE TABLE "week_unlocks" (
  "id"             UUID               NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id"  UUID               NOT NULL,
  "week_id"        UUID               NOT NULL,
  "source"         "WeekUnlockSource" NOT NULL,
  "unlocked_by_id" UUID,
  "reason"         VARCHAR(300),
  "created_at"     TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "week_unlocks_pkey" PRIMARY KEY ("id"),
  -- An early opening always says WHO opened it and WHY; an opening caused by progress has neither.
  CONSTRAINT "week_unlocks_early_open_check"
    CHECK (("source" = 'EARLY_OPEN') = ("unlocked_by_id" IS NOT NULL)
       AND ("source" = 'EARLY_OPEN') = ("reason" IS NOT NULL))
);

CREATE UNIQUE INDEX "week_unlocks_enrollment_id_week_id_key" ON "week_unlocks"("enrollment_id", "week_id");

ALTER TABLE "week_unlocks"
  ADD CONSTRAINT "week_unlocks_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
