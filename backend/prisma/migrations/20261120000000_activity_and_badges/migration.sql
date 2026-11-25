-- Batch 5A: the student's activity feed and badges.
--
--   activity_events  an APPEND-ONLY log of what happened in a student's learning: she joined her
--                    cohort, completed a lesson, sent a submission, received a review, earned a
--                    badge. The activity feed is read from it. Each event has a unique key, so the
--                    same thing is never logged twice (the one-time catch-up for students who
--                    already had progress, and the live recording, can overlap safely).
--   student_badges   the badges a student has earned, and when. Never changed or removed.
--
-- Both belong to an ENROLLMENT, like the rest of her progress. They hold ids and small facts
-- only - never feedback text or scores.
-- Written by hand (CHECK rules and a trigger); names follow Prisma's conventions.

CREATE TYPE "ActivityType" AS ENUM ('ENROLLED', 'LESSON_COMPLETED', 'SUBMISSION_SENT', 'REVIEW_RECEIVED', 'BADGE_EARNED');

CREATE TYPE "BadgeKey" AS ENUM (
  'WELCOME_ABOARD', 'FIRST_SUBMISSION', 'ON_TIME', 'FEEDBACK_LOOP', 'HALFWAY_THERE', 'SHOWCASE_READY'
);

-- ---------------------------------------------------------------------------
CREATE TABLE "activity_events" (
  "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id" UUID           NOT NULL,
  "type"          "ActivityType" NOT NULL,
  -- Says WHAT this event is about ("lesson:<id>", "version:<id>", "review:<id>", "badge:<KEY>", "enrolled").
  "ref_key"       VARCHAR(100)   NOT NULL,
  -- When it really happened (not when it was logged).
  "occurred_at"   TIMESTAMPTZ(3) NOT NULL,
  "details"       JSONB          NOT NULL DEFAULT '{}',
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_events_ref_key_check" CHECK (btrim("ref_key") <> ''),
  CONSTRAINT "activity_events_details_check" CHECK (jsonb_typeof("details") = 'object')
);

CREATE UNIQUE INDEX "activity_events_enrollment_id_type_ref_key_key" ON "activity_events"("enrollment_id", "type", "ref_key");
CREATE INDEX "activity_events_enrollment_id_occurred_at_idx" ON "activity_events"("enrollment_id", "occurred_at");

ALTER TABLE "activity_events"
  ADD CONSTRAINT "activity_events_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
CREATE TABLE "student_badges" (
  "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id" UUID           NOT NULL,
  "badge"         "BadgeKey"     NOT NULL,
  "earned_at"     TIMESTAMPTZ(3) NOT NULL,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "student_badges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "student_badges_enrollment_id_badge_key" ON "student_badges"("enrollment_id", "badge");

ALTER TABLE "student_badges"
  ADD CONSTRAINT "student_badges_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- HAND-WRITTEN rule: the log and the badges are append-only. Nothing is ever changed or deleted.
CREATE FUNCTION "activity_records_refuse_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be changed or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "activity_events_append_only"
  BEFORE UPDATE OR DELETE ON "activity_events"
  FOR EACH ROW EXECUTE FUNCTION "activity_records_refuse_change"();
CREATE TRIGGER "student_badges_append_only"
  BEFORE UPDATE OR DELETE ON "student_badges"
  FOR EACH ROW EXECUTE FUNCTION "activity_records_refuse_change"();
