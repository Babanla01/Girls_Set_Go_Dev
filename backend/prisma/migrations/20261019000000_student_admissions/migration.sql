-- ============================================================================
-- Migration: student_admissions  (Batch 6)
-- Student profiles, applications and enrollments, plus a verified-email marker.
--
-- Part 1 mirrors prisma/schema.prisma exactly (same names and types).
-- Part 2 ("HAND-WRITTEN") adds database rules Prisma cannot describe.
-- Apply with:  npm run db:deploy
-- ============================================================================

-- ---------------------------------------------------------------- PART 1 ---

-- AlterEnum
ALTER TYPE "AuthTokenType" ADD VALUE 'EMAIL_VERIFICATION';

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'TRANSFERRED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "student_profiles" (
    "user_id" UUID NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "phone" VARCHAR(30) NOT NULL,
    "location" VARCHAR(200) NOT NULL,
    "school_name" VARCHAR(200) NOT NULL,
    "grade_level" VARCHAR(50) NOT NULL,
    "guardian_name" VARCHAR(120),
    "guardian_email" VARCHAR(254),
    "guardian_phone" VARCHAR(30),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "student_applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "preferred_track_id" UUID,
    "why_join" VARCHAR(2000) NOT NULL,
    "hope_to_learn" VARCHAR(2000) NOT NULL,
    "stem_experience" VARCHAR(2000),
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "decision_note" VARCHAR(1000),
    "consent_accepted_at" TIMESTAMPTZ(3) NOT NULL,
    "guardian_consent_at" TIMESTAMPTZ(3),
    "consent_version" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "cohort_id" UUID NOT NULL,
    "application_id" UUID,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "enrolled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "student_applications_student_id_key" ON "student_applications"("student_id");

-- CreateIndex
CREATE INDEX "student_applications_status_submitted_at_idx" ON "student_applications"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "student_applications_preferred_track_id_idx" ON "student_applications"("preferred_track_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_application_id_key" ON "enrollments"("application_id");

-- CreateIndex
CREATE INDEX "enrollments_cohort_id_status_idx" ON "enrollments"("cohort_id", "status");

-- CreateIndex
CREATE INDEX "enrollments_student_id_status_idx" ON "enrollments"("student_id", "status");

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_applications" ADD CONSTRAINT "student_applications_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_applications" ADD CONSTRAINT "student_applications_preferred_track_id_fkey" FOREIGN KEY ("preferred_track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_applications" ADD CONSTRAINT "student_applications_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "cohorts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "student_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ------------------------------------------------------ PART 2: HAND-WRITTEN
-- Rules the database itself enforces, even if application code has a bug.
-- Prisma does not model these, so they live only in this SQL file.

-- A believable date of birth: not in the future, not before 1900.
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_dob_chk"
  CHECK ("date_of_birth" >= DATE '1900-01-01' AND "date_of_birth" <= CURRENT_DATE);

-- Guardian details come as a set: all three, or none.
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_guardian_all_or_none_chk"
  CHECK (
    ("guardian_name" IS NULL AND "guardian_email" IS NULL AND "guardian_phone" IS NULL)
    OR ("guardian_name" IS NOT NULL AND "guardian_email" IS NOT NULL AND "guardian_phone" IS NOT NULL)
  );

-- A guardian email, like every email we store, is lowercase.
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_guardian_email_lowercase_chk"
  CHECK ("guardian_email" IS NULL OR "guardian_email" = lower("guardian_email"));

-- An application is PENDING exactly when nobody has decided it yet; a decided
-- one always records who decided and when.
ALTER TABLE "student_applications"
  ADD CONSTRAINT "student_applications_review_consistent_chk"
  CHECK (
    ("status" = 'PENDING' AND "reviewed_at" IS NULL AND "reviewed_by_id" IS NULL)
    OR ("status" <> 'PENDING' AND "reviewed_at" IS NOT NULL AND "reviewed_by_id" IS NOT NULL)
  );

-- An enrollment is ACTIVE exactly while it has no end date.
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_ended_consistent_chk"
  CHECK (
    ("status" = 'ACTIVE' AND "ended_at" IS NULL)
    OR ("status" <> 'ACTIVE' AND "ended_at" IS NOT NULL)
  );

-- A student can have only ONE active enrollment. (This is what stops a student
-- being silently enrolled in two tracks at once.)
CREATE UNIQUE INDEX "enrollments_one_active_per_student_key"
  ON "enrollments" ("student_id")
  WHERE "status" = 'ACTIVE';

-- Profiles, applications and enrollments belong to STUDENT accounts only.
-- One function serves all three tables; the column to check is passed as an
-- argument when the trigger is created.
CREATE FUNCTION "require_student_user"() RETURNS trigger AS $$
DECLARE
  user_id uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = user_id AND "role" = 'STUDENT') THEN
    RAISE EXCEPTION '% requires a user with the STUDENT role', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "student_profiles_only_students"
  BEFORE INSERT OR UPDATE OF "user_id" ON "student_profiles"
  FOR EACH ROW EXECUTE FUNCTION "require_student_user"('user_id');

CREATE TRIGGER "student_applications_only_students"
  BEFORE INSERT OR UPDATE OF "student_id" ON "student_applications"
  FOR EACH ROW EXECUTE FUNCTION "require_student_user"('student_id');

CREATE TRIGGER "enrollments_only_students"
  BEFORE INSERT OR UPDATE OF "student_id" ON "enrollments"
  FOR EACH ROW EXECUTE FUNCTION "require_student_user"('student_id');