-- Batch 5B: what a student can say about herself, and a small per-user setting.
--
--   student_profiles   three new columns: her interests (a short list of chips), her goal for the
--                      bootcamp (up to 280 characters) and her "after the bootcamp" choice. These
--                      are visible only to her, her instructors and the admins - never public.
--   user_preferences   one row per person who has changed a setting: for now, whether the profile
--                      panel is open, collapsed to a thin rail, or closed. Remembered per user.
-- Written by hand (CHECK rules); names follow Prisma's conventions.

ALTER TABLE "student_profiles"
  ADD COLUMN "interests"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "goal"           VARCHAR(280),
  ADD COLUMN "after_bootcamp" VARCHAR(60);

-- At most 10 interests; a goal or choice is either empty (NULL) or real text - never blank.
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_interests_check"      CHECK (cardinality("interests") <= 10),
  ADD CONSTRAINT "student_profiles_goal_check"           CHECK ("goal" IS NULL OR btrim("goal") <> ''),
  ADD CONSTRAINT "student_profiles_after_bootcamp_check" CHECK ("after_bootcamp" IS NULL OR btrim("after_bootcamp") <> '');

-- ---------------------------------------------------------------------------
CREATE TYPE "PanelState" AS ENUM ('OPEN', 'COLLAPSED', 'CLOSED');

CREATE TABLE "user_preferences" (
  "user_id"       UUID           NOT NULL,
  "profile_panel" "PanelState"   NOT NULL DEFAULT 'OPEN',
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_preferences"
  ADD CONSTRAINT "user_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
