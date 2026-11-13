-- Batch 4C-1: an instructor's review of one version of a student's submission.
--
--   submission_reviews   one review per submitted VERSION: four rubric scores (1 to 4), one
--                        strength, one next step, the outcome, and - for "needs revision" - how many
--                        days the student has to resubmit. It can be edited by its author for 24 hours
--                        (enforced by the application and written to the audit log); it can never be
--                        deleted. The (submission, version) pair is linked to submission_versions, so a
--                        review always belongs to a version that really exists.
-- Written by hand (CHECK rules and a trigger); names follow Prisma's conventions.

CREATE TYPE "ReviewOutcome" AS ENUM ('REVIEWED', 'NEEDS_REVISION', 'COMPLETED');

CREATE TABLE "submission_reviews" (
  "id"                  UUID            NOT NULL DEFAULT gen_random_uuid(),
  "submission_id"       UUID            NOT NULL,
  "version_number"      INTEGER         NOT NULL,
  "reviewer_id"         UUID            NOT NULL,
  "score_understanding" SMALLINT        NOT NULL,
  "score_execution"     SMALLINT        NOT NULL,
  "score_testing"       SMALLINT        NOT NULL,
  "score_communication" SMALLINT        NOT NULL,
  "strength"            VARCHAR(500)    NOT NULL,
  "next_step"           VARCHAR(500)    NOT NULL,
  "outcome"             "ReviewOutcome" NOT NULL,
  "revision_days"       INTEGER,
  "created_at"          TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "edited_at"           TIMESTAMPTZ(3),
  CONSTRAINT "submission_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "submission_reviews_scores_check"
    CHECK ("score_understanding" BETWEEN 1 AND 4 AND "score_execution" BETWEEN 1 AND 4
       AND "score_testing" BETWEEN 1 AND 4 AND "score_communication" BETWEEN 1 AND 4),
  CONSTRAINT "submission_reviews_strength_check" CHECK (btrim("strength") <> ''),
  CONSTRAINT "submission_reviews_next_step_check" CHECK (btrim("next_step") <> ''),
  -- "Days to resubmit" belongs to "needs revision" and to nothing else.
  CONSTRAINT "submission_reviews_revision_days_check"
    CHECK (("outcome" = 'NEEDS_REVISION') = ("revision_days" IS NOT NULL)
       AND ("revision_days" IS NULL OR "revision_days" BETWEEN 1 AND 14)),
  CONSTRAINT "submission_reviews_edited_check" CHECK ("edited_at" IS NULL OR "edited_at" >= "created_at")
);

CREATE UNIQUE INDEX "submission_reviews_submission_id_version_number_key" ON "submission_reviews"("submission_id", "version_number");
CREATE INDEX "submission_reviews_reviewer_id_created_at_idx" ON "submission_reviews"("reviewer_id", "created_at");

ALTER TABLE "submission_reviews"
  ADD CONSTRAINT "submission_reviews_submission_id_version_number_fkey"
    FOREIGN KEY ("submission_id", "version_number") REFERENCES "submission_versions"("submission_id", "number")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- HAND-WRITTEN rule: a review is never deleted (it can be edited for 24 hours, and that is audited).
CREATE FUNCTION "submission_reviews_refuse_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'submission_reviews rows cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "submission_reviews_keep"
  BEFORE DELETE ON "submission_reviews"
  FOR EACH ROW EXECUTE FUNCTION "submission_reviews_refuse_delete"();
