-- ============================================================================
-- Migration: tracks_courses_cohorts  (Batch 5)
--
-- Part 1 mirrors prisma/schema.prisma exactly (same names and types).
-- Part 2 ("HAND-WRITTEN") adds database rules Prisma cannot describe.
-- Apply with:  npx prisma migrate deploy
-- ============================================================================

-- ---------------------------------------------------------------- PART 1 ---

-- CreateEnum
CREATE TYPE "TrackStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CohortStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "tracks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "name_key" VARCHAR(100) NOT NULL,
    "description" VARCHAR(2000),
    "status" "TrackStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "track_id" UUID NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "title_key" VARCHAR(150) NOT NULL,
    "description" VARCHAR(5000),
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cohorts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "name_key" VARCHAR(120) NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "capacity" INTEGER,
    "status" "CohortStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cohort_instructors" (
    "cohort_id" UUID NOT NULL,
    "instructor_id" UUID NOT NULL,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cohort_instructors_pkey" PRIMARY KEY ("cohort_id","instructor_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracks_name_key_key" ON "tracks"("name_key");

-- CreateIndex
CREATE INDEX "courses_track_id_status_idx" ON "courses"("track_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "courses_track_id_title_key_key" ON "courses"("track_id", "title_key");

-- CreateIndex
CREATE INDEX "cohorts_course_id_status_idx" ON "cohorts"("course_id", "status");

-- CreateIndex
CREATE INDEX "cohorts_status_starts_on_idx" ON "cohorts"("status", "starts_on");

-- CreateIndex
CREATE UNIQUE INDEX "cohorts_course_id_name_key_key" ON "cohorts"("course_id", "name_key");

-- CreateIndex
CREATE INDEX "cohort_instructors_instructor_id_idx" ON "cohort_instructors"("instructor_id");

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cohort_instructors" ADD CONSTRAINT "cohort_instructors_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "cohorts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cohort_instructors" ADD CONSTRAINT "cohort_instructors_instructor_id_fkey" FOREIGN KEY ("instructor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cohort_instructors" ADD CONSTRAINT "cohort_instructors_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ------------------------------------------------------ PART 2: HAND-WRITTEN
-- Rules the database itself enforces, even if application code has a bug.
-- Prisma does not model these, so they live only in this SQL file.

-- Names and titles can never be blank.
ALTER TABLE "tracks"  ADD CONSTRAINT "tracks_name_not_blank_chk"   CHECK (length(btrim("name")) > 0);
ALTER TABLE "courses" ADD CONSTRAINT "courses_title_not_blank_chk" CHECK (length(btrim("title")) > 0);
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_name_not_blank_chk"  CHECK (length(btrim("name")) > 0);

-- The lowercase "key" copy must always match the real name, so the uniqueness
-- rule ("no two tracks differing only by capitals") can never be bypassed.
ALTER TABLE "tracks"  ADD CONSTRAINT "tracks_name_key_matches_chk"   CHECK ("name_key" = lower("name"));
ALTER TABLE "courses" ADD CONSTRAINT "courses_title_key_matches_chk" CHECK ("title_key" = lower("title"));
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_name_key_matches_chk"  CHECK ("name_key" = lower("name"));

-- A cohort cannot end before it starts.
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_dates_chk" CHECK ("ends_on" >= "starts_on");

-- Capacity, when set, must be a sensible number.
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_capacity_chk"
  CHECK ("capacity" IS NULL OR ("capacity" >= 1 AND "capacity" <= 10000));

-- Only users whose role is INSTRUCTOR can be assigned to teach a cohort.
CREATE FUNCTION "cohort_instructors_require_instructor"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "users" WHERE "id" = NEW."instructor_id" AND "role" = 'INSTRUCTOR'
  ) THEN
    RAISE EXCEPTION 'Only users with the INSTRUCTOR role can be assigned to a cohort';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cohort_instructors_only_instructors"
  BEFORE INSERT OR UPDATE OF "instructor_id" ON "cohort_instructors"
  FOR EACH ROW EXECUTE FUNCTION "cohort_instructors_require_instructor"();