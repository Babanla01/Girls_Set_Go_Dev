-- Batch 1A: align statuses with the design.
--
-- Cohort:     ACTIVE / ARCHIVED   ->   PLANNED / ACTIVE / CLOSED
--             (existing ARCHIVED cohorts simply become CLOSED)
-- Enrollment: add COMPLETED (finished the course; content stays readable)
--
-- NOTE: a brand-new enum value cannot be USED in the same transaction that adds
-- it, so the new column default (PLANNED) is set in the NEXT migration.

ALTER TYPE "CohortStatus" RENAME VALUE 'ARCHIVED' TO 'CLOSED';
ALTER TYPE "CohortStatus" ADD VALUE IF NOT EXISTS 'PLANNED' BEFORE 'ACTIVE';

ALTER TYPE "EnrollmentStatus" ADD VALUE IF NOT EXISTS 'COMPLETED' AFTER 'ACTIVE';
