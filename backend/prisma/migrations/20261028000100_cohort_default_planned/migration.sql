-- Batch 1A (part 2): new cohorts start as PLANNED until an admin starts them.
-- Existing cohorts keep their current status (ACTIVE stays ACTIVE).

ALTER TABLE "cohorts" ALTER COLUMN "status" SET DEFAULT 'PLANNED';
