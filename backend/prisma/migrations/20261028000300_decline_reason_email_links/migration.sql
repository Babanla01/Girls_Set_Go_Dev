-- Batch 1B-ii: decline details and email tracking.
--
--   1. A declined application records WHY (internal, for reporting only) and an
--      optional personal note that is emailed to the student.
--   2. Emails can be LINKED to the thing they are about (for example an
--      application), so an admin can see on that page whether they were delivered.
--
-- Existing declined applications get the reason OTHER (they had no reason before).

-- ---------------------------------------------------------------------------
-- 1) Decline reason + personal note
-- ---------------------------------------------------------------------------
CREATE TYPE "DeclineReason" AS ENUM (
  'NOT_ELIGIBLE',
  'COHORT_FULL',
  'INCOMPLETE_INFORMATION',
  'DUPLICATE_APPLICATION',
  'OTHER'
);

ALTER TABLE "student_applications"
  ADD COLUMN "decline_reason" "DeclineReason",
  ADD COLUMN "personal_note"  VARCHAR(500);

UPDATE "student_applications" SET "decline_reason" = 'OTHER' WHERE "status" = 'DECLINED';

-- HAND-WRITTEN rules: the reason exists exactly when the application is declined,
-- and a personal note only ever belongs to a declined application.
ALTER TABLE "student_applications"
  ADD CONSTRAINT "student_applications_decline_reason_check"
    CHECK (("status" = 'DECLINED') = ("decline_reason" IS NOT NULL)),
  ADD CONSTRAINT "student_applications_personal_note_check"
    CHECK ("personal_note" IS NULL OR "status" = 'DECLINED');

-- ---------------------------------------------------------------------------
-- 2) Link an email to what it is about ("student_application" + the id)
--    Older emails stay unlinked (their stored values are already wiped after sending).
-- ---------------------------------------------------------------------------
ALTER TABLE "email_outbox"
  ADD COLUMN "entity_type" VARCHAR(50),
  ADD COLUMN "entity_id"   VARCHAR(64);

CREATE INDEX "email_outbox_entity_type_entity_id_idx" ON "email_outbox"("entity_type", "entity_id");
