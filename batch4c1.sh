#!/usr/bin/env bash
# Batch 4C-1 - shared storage for submissions, reviews, the grading inbox, and the "graded opens the next week" rule.
# Run from the repo root.
set -euo pipefail
cd backend
mkdir -p prisma/migrations/20261103000000_submission_reviews src/learning/uploads src/grading/dto

# --- my own storage module is replaced by the shared one in src/platform/storage ------------
rm -rf src/storage

# ============================================================================
cat > prisma/migrations/20261103000000_submission_reviews/migration.sql <<'EOF'
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
EOF

# ============================================================================
# The upload checks keep living in the learning module (the shared storage has none).
cat > src/learning/uploads/upload.constants.ts <<'EOF'
/**
 * upload.constants.ts
 * ---------------------------------------------------------------------------
 * The limits of a student upload, in ONE place.
 */

/** The biggest single upload (20 MB). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Longest file name we keep (the real name is only for display; storage uses a random key). */
export const MAX_FILE_NAME_LENGTH = 120;
EOF

cat > src/learning/uploads/file-types.ts <<'EOF'
/**
 * file-types.ts
 * ---------------------------------------------------------------------------
 * The file types a student upload may have, and how to recognise a REAL one.
 *
 * A file's name can say anything ("virus.exe" renamed to "work.pdf"), so every upload is
 * also checked against what its first bytes must look like:
 *   pdf   starts with "%PDF-"            png   the 8-byte PNG signature     jpg   FF D8 FF
 *   docx / pptx / zip   start like a zip archive ("PK")
 *   ino / py            plain text: valid UTF-8 with no zero bytes
 *
 * `inline` says whether a browser may show the file in the page (pdf and images); everything
 * else is always offered as a download (the shared file route decides that from the type).
 */
import { isUtf8 } from 'node:buffer';

import { FileType } from '../../course-content/assignment-data';

export interface FileTypeInfo {
  contentType: string;
  inline: boolean;
  /** null when the contents look right, otherwise a short reason ("is not a real PDF"). */
  problemWith(buffer: Buffer): string | null;
}

const startsWith = (buffer: Buffer, bytes: number[]): boolean =>
  buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

const signature = (label: string, bytes: number[]) => (buffer: Buffer): string | null =>
  startsWith(buffer, bytes) ? null : `is not a real ${label} file`;

const ZIP_START = [0x50, 0x4b, 0x03, 0x04];

const plainText = (label: string) => (buffer: Buffer): string | null =>
  buffer.includes(0) || !isUtf8(buffer) ? `is not a plain-text ${label} file` : null;

export const FILE_TYPES: Record<FileType, FileTypeInfo> = {
  pdf: { contentType: 'application/pdf', inline: true, problemWith: signature('PDF', [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  png: { contentType: 'image/png', inline: true, problemWith: signature('PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { contentType: 'image/jpeg', inline: true, problemWith: signature('JPEG', [0xff, 0xd8, 0xff]) },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    inline: false,
    problemWith: signature('Word', ZIP_START),
  },
  pptx: {
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    inline: false,
    problemWith: signature('PowerPoint', ZIP_START),
  },
  zip: { contentType: 'application/zip', inline: false, problemWith: signature('zip', ZIP_START) },
  ino: { contentType: 'text/plain; charset=utf-8', inline: false, problemWith: plainText('Arduino') },
  py: { contentType: 'text/plain; charset=utf-8', inline: false, problemWith: plainText('Python') },
};
EOF

cat > src/learning/uploads/upload-checks.ts <<'EOF'
/**
 * upload-checks.ts
 * ---------------------------------------------------------------------------
 * Checks a batch of uploaded files BEFORE anything is stored. Pure functions (no disk, no
 * database), so they are easy to test on their own. Every problem is reported together.
 *
 * For each file:
 *   - its name is cleaned (no folders, no control characters, a sensible length);
 *   - its type (from the extension) must be one the assignment allows;
 *   - it must not be empty and must be within the size limit;
 *   - its contents must really look like that type (see file-types.ts);
 *   - the same file cannot be added twice in one submission.
 */
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

import { ALLOWED_FILE_TYPES, FileType } from '../../course-content/assignment-data';
import { FILE_TYPES } from './file-types';
import { MAX_FILE_NAME_LENGTH } from './upload.constants';

/** What the upload library hands us for each file. */
export interface IncomingFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export interface CheckedFile {
  /** The cleaned display name. */
  name: string;
  type: FileType;
  contentType: string;
  buffer: Buffer;
  size: number;
  sha256: string;
}

/** Upload libraries often read a UTF-8 file name as Latin-1 ("cafÃ©"); this puts it right. */
function fixEncoding(name: string): string {
  const bytes = Buffer.from(name, 'latin1');
  return isUtf8(bytes) ? bytes.toString('utf8') : name;
}

/** A safe name for display: no folders, no control characters, not too long (the extension is kept). */
export function cleanFileName(name: string): string {
  const base = fixEncoding(name).split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (cleaned === '') return 'file';
  if (cleaned.length <= MAX_FILE_NAME_LENGTH) return cleaned;

  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_FILE_NAME_LENGTH - extension.length) + extension;
}

/** The lower-case extension without the dot ("jpeg" counts as "jpg"); empty when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  const extension = name.slice(dot + 1).toLowerCase();
  return extension === 'jpeg' ? 'jpg' : extension;
}

export function checkUploads(
  files: readonly IncomingFile[],
  allowed: readonly string[],
  limits: { maxFiles: number; maxBytes: number },
): { files: CheckedFile[]; problems: string[] } {
  const problems: string[] = [];
  const accepted: CheckedFile[] = [];

  if (files.length === 0) return { files: [], problems };
  if (allowed.length === 0) return { files: [], problems: ['This assignment does not accept file uploads. Share a link instead.'] };
  if (files.length > limits.maxFiles) problems.push(`You can upload at most ${limits.maxFiles} files.`);

  const known = new Set<string>(ALLOWED_FILE_TYPES);
  const firstWithChecksum = new Map<string, string>();

  for (const file of files) {
    const name = cleanFileName(file.originalname);
    const extension = extensionOf(name);

    if (!known.has(extension) || !allowed.includes(extension)) {
      problems.push(`"${name}" is not an allowed file type. Allowed: ${allowed.join(', ')}.`);
      continue;
    }
    if (file.size === 0 || file.buffer.length === 0) {
      problems.push(`"${name}" is empty.`);
      continue;
    }
    if (file.size > limits.maxBytes) {
      problems.push(`"${name}" is larger than ${Math.round(limits.maxBytes / (1024 * 1024))} MB.`);
      continue;
    }

    const type = extension as FileType;
    const info = FILE_TYPES[type];
    const wrong = info.problemWith(file.buffer);
    if (wrong) {
      problems.push(`"${name}" ${wrong}. Check that you uploaded the right file.`);
      continue;
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const duplicate = firstWithChecksum.get(sha256);
    if (duplicate) {
      problems.push(`"${name}" is the same file as "${duplicate}".`);
      continue;
    }
    firstWithChecksum.set(sha256, name);

    accepted.push({ name, type, contentType: info.contentType, buffer: file.buffer, size: file.size, sha256 });
  }

  return { files: problems.length === 0 ? accepted : [], problems };
}
EOF

# ============================================================================
cat > src/learning/submission-files.service.ts <<'EOF'
/**
 * submission-files.service.ts
 * ---------------------------------------------------------------------------
 * Files that belong to student submissions, kept in the SHARED file storage
 * (src/platform/storage) - the same "one door" the website side uses.
 *
 *  - A file is stored under a private key, "private/submissions/<id>": never under the
 *    student's file name, and never reachable without a signed link.
 *  - A link is made for ONE person (the one who asked to see the file) and works for a few
 *    minutes: a student's link cannot be passed on, and an instructor's link works only for
 *    that instructor. Links are made fresh every time a page is loaded.
 *  - The database keeps what each file is (name, type, size, SHA-256 checksum) in
 *    "stored_files"; the bytes live in storage.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { SignedUrlService } from '../platform/storage/signed-url.service';
import { StorageService } from '../platform/storage/storage.service';

export interface SaveFileInput {
  name: string;
  contentType: string;
  buffer: Buffer;
  sha256: string;
  uploadedById: string;
}

export interface StoredFileView {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
}

/** What is needed to make a link for a stored file. */
export interface LinkableFile {
  storageKey: string;
  contentType: string;
  originalName: string;
}

/** Where file links are served (the shared private-file route). */
const PRIVATE_LINK_PREFIX = '/api/v1/files/private';

@Injectable()
export class SubmissionFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly signed: SignedUrlService,
  ) {}

  /** Stores the bytes, then records the file. If recording fails, the bytes are removed again. */
  async save(input: SaveFileInput): Promise<StoredFileView> {
    const id = randomUUID();
    const storageKey = `private/submissions/${id}`;

    await this.storage.put(storageKey, input.buffer);
    try {
      await this.prisma.storedFile.create({
        data: {
          id,
          storageKey,
          originalName: input.name,
          contentType: input.contentType,
          sizeBytes: input.buffer.length,
          sha256: input.sha256,
          uploadedById: input.uploadedById,
        },
      });
    } catch (error) {
      await this.storage.delete(storageKey); // never leave a file nothing knows about
      throw error;
    }
    return { id, name: input.name, contentType: input.contentType, sizeBytes: input.buffer.length };
  }

  /** A short-lived link for ONE person to open ONE file. */
  linkFor(file: LinkableFile, viewerId: string): string {
    const token = this.signed.sign({
      key: file.storageKey,
      contentType: file.contentType,
      filename: file.originalName,
      userId: viewerId,
    });
    return `${PRIVATE_LINK_PREFIX}/${token}`;
  }

  /** Removes a file nothing refers to (the clean-up after a failed submission). */
  async remove(fileId: string): Promise<void> {
    const row = await this.prisma.storedFile.findUnique({ where: { id: fileId }, select: { storageKey: true } });
    if (!row) return;
    await this.prisma.storedFile.delete({ where: { id: fileId } }); // refused while a submission still uses it
    await this.storage.delete(row.storageKey);
  }
}
EOF

# ============================================================================
cat > src/learning/graded-weeks.ts <<'EOF'
/**
 * graded-weeks.ts
 * ---------------------------------------------------------------------------
 * "A week opens when the previous week's lessons are complete AND its assignment has been
 * reviewed." A week counts as GRADED when:
 *   - it has no assignment at all (nothing to wait for), or
 *   - its assignment has been reviewed (in any outcome: reviewed, needs revision, completed).
 * Pure function, so it is easy to test.
 */
import type { Snapshot } from '../course-content/snapshot';

export function gradedWeekIds(snapshot: Snapshot, reviewedAssignmentIds: ReadonlySet<string>): Set<string> {
  return new Set(
    snapshot.weeks
      .filter((week) => !week.assignment || reviewedAssignmentIds.has(week.assignment.id))
      .map((week) => week.id),
  );
}
EOF

# ============================================================================
cat > src/learning/progress-state.service.ts <<'EOF'
/**
 * progress-state.service.ts
 * ---------------------------------------------------------------------------
 * Everything the rules need to know about ONE student's progress, read in one place:
 *   completed   the lessons she marked complete
 *   unlocked    the weeks already opened for her (by progress, or early by an instructor)
 *   graded      the weeks whose assignment was reviewed (or that have no assignment)
 * and the two things done with it: working out which weeks are open (learning-rules.ts), and
 * RECORDING a week the moment it opens, so it stays open even if the course changes later.
 *
 * Used by the lesson screens, the assignment screens, "open a week early" and by reviews.
 */
import { Injectable } from '@nestjs/common';
import { WeekUnlockSource } from '@prisma/client';

import type { DbClient } from '../common/types/db-client';
import type { Snapshot } from '../course-content/snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { gradedWeekIds } from './graded-weeks';
import { evaluateWeeks, WeekProgress } from './learning-rules';

export interface ProgressState {
  completed: Set<string>;
  unlocked: Set<string>;
  graded: Set<string>;
}

@Injectable()
export class ProgressStateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Three quick queries, run together. */
  async load(db: DbClient, enrollmentId: string, snapshot: Snapshot): Promise<ProgressState> {
    const [done, opened, reviewed] = await Promise.all([
      db.lessonProgress.findMany({ where: { enrollmentId, completedAt: { not: null } }, select: { lessonId: true } }),
      db.weekUnlock.findMany({ where: { enrollmentId }, select: { weekId: true } }),
      db.submission.findMany({
        where: { enrollmentId, versions: { some: { review: { isNot: null } } } },
        select: { assignmentId: true },
      }),
    ]);

    return {
      completed: new Set(done.map((row) => row.lessonId)),
      unlocked: new Set(opened.map((row) => row.weekId)),
      graded: gradedWeekIds(snapshot, new Set(reviewed.map((row) => row.assignmentId))),
    };
  }

  /** Which weeks are open, and how far she got in each. `allOpen` is for a student who finished the course. */
  evaluate(snapshot: Snapshot, state: ProgressState, allOpen = false): WeekProgress[] {
    return evaluateWeeks(snapshot, {
      completed: state.completed,
      unlocked: state.unlocked,
      gradedWeeks: state.graded,
      allOpen,
    });
  }

  /** Remembers the weeks that just opened (those open `after` but not `before`) and returns them. */
  async recordOpenings(
    db: DbClient,
    enrollmentId: string,
    before: readonly WeekProgress[],
    after: readonly WeekProgress[],
  ): Promise<WeekProgress[]> {
    const justOpened = after.filter((week, index) => week.open && !before[index].open);
    if (justOpened.length > 0) {
      await db.weekUnlock.createMany({
        data: justOpened.map((week) => ({ enrollmentId, weekId: week.id, source: WeekUnlockSource.PROGRESS })),
        skipDuplicates: true,
      });
    }
    return justOpened;
  }
}
EOF

# ============================================================================
cat > src/grading/grading.constants.ts <<'EOF'
/**
 * grading.constants.ts
 * ---------------------------------------------------------------------------
 * The rules of reviewing, in ONE place.
 */

/** The author of a review can change it for this long after first saving it. */
export const EDIT_WINDOW_HOURS = 24;

/** The longest a student may be given to resubmit after "needs revision". */
export const MAX_REVISION_DAYS = 14;
EOF

cat > src/grading/review-rules.ts <<'EOF'
/**
 * review-rules.ts
 * ---------------------------------------------------------------------------
 * Two small rules of reviewing, as pure functions (no database):
 *   - how many days a student gets to resubmit (only for "needs revision");
 *   - who may still EDIT a review (its author, for 24 hours).
 */
import { REVISION_WINDOW_DAYS } from '../learning/submission.constants';
import { EDIT_WINDOW_HOURS, MAX_REVISION_DAYS } from './grading.constants';

export type OutcomeValue = 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';

/**
 * The days to resubmit for this outcome. "Needs revision" uses the number given (7 when none was);
 * the other outcomes take no days at all.
 */
export function revisionDaysFor(outcome: OutcomeValue, requested: number | undefined): { days: number | null; problem: string | null } {
  if (outcome === 'NEEDS_REVISION') {
    const days = requested ?? REVISION_WINDOW_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_REVISION_DAYS) {
      return { days: null, problem: `revisionDays must be a whole number from 1 to ${MAX_REVISION_DAYS}.` };
    }
    return { days, problem: null };
  }
  if (requested !== undefined) return { days: null, problem: 'revisionDays only applies when the outcome is NEEDS_REVISION.' };
  return { days: null, problem: null };
}

export const EDIT_NOT_AUTHOR_MESSAGE = 'Only the instructor who wrote this feedback can change it.';
export const EDIT_EXPIRED_MESSAGE = `Feedback can only be edited for ${EDIT_WINDOW_HOURS} hours after it was first saved.`;

export interface EditInput {
  reviewerId: string;
  userId: string;
  /** When the review was first saved. */
  createdAt: Date;
  now: Date;
}

export interface EditDecision {
  allowed: boolean;
  /** 'AUTHOR' = not hers to edit, 'EXPIRED' = the 24 hours are over. */
  blockedBy: 'AUTHOR' | 'EXPIRED' | null;
  reason: string | null;
}

export function editDecision(input: EditInput): EditDecision {
  if (input.reviewerId !== input.userId) return { allowed: false, blockedBy: 'AUTHOR', reason: EDIT_NOT_AUTHOR_MESSAGE };
  const deadline = input.createdAt.getTime() + EDIT_WINDOW_HOURS * 3_600_000;
  if (input.now.getTime() > deadline) return { allowed: false, blockedBy: 'EXPIRED', reason: EDIT_EXPIRED_MESSAGE };
  return { allowed: true, blockedBy: null, reason: null };
}
EOF

# ============================================================================
cat > src/grading/dto/inbox.query.ts <<'EOF'
/**
 * inbox.query.ts
 * ---------------------------------------------------------------------------
 *   ?status=WAITING|NEEDS_REVISION|REVIEWED|COMPLETED|ALL   (default WAITING: still to be reviewed)
 *   &cohortId=<uuid>&courseId=<uuid>                         narrow to one cohort / course
 *   &from=2026-10-01&to=2026-10-31                           last activity between these days (Chicago time)
 *   &search=ada   or   &search=GSG-SUB-12                    student name, or receipt number
 *   &page=1&pageSize=20
 */
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination/pagination';
import { IsCalendarDate } from '../../common/validation/calendar-date.decorator';

export const INBOX_STATUSES = ['WAITING', 'NEEDS_REVISION', 'REVIEWED', 'COMPLETED', 'ALL'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export class InboxQuery extends PaginationQueryDto {
  @IsOptional()
  @IsIn(INBOX_STATUSES)
  status?: InboxStatus;

  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  /** First day (inclusive), "YYYY-MM-DD". */
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  /** Last day (inclusive), "YYYY-MM-DD". */
  @IsOptional()
  @IsCalendarDate()
  to?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(100)
  search?: string;
}
EOF

cat > src/grading/dto/review.dto.ts <<'EOF'
/**
 * review.dto.ts - what the instructor sends when saving a review.
 *
 * Every review has all four scores (1 to 4), one strength and one next step, plus the outcome.
 * `versionNumber` is the version she was looking at: if the student sent a newer one meanwhile,
 * the save is refused instead of being applied to work the instructor never saw.
 */
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { ReviewOutcome } from '@prisma/client';

import { MAX_REVISION_DAYS } from '../grading.constants';

/** Keeps line breaks, trims the ends. */
const feedbackText = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : value);

export class ScoresDto {
  @IsInt() @Min(1) @Max(4) understanding!: number;
  @IsInt() @Min(1) @Max(4) execution!: number;
  @IsInt() @Min(1) @Max(4) testing!: number;
  @IsInt() @Min(1) @Max(4) communication!: number;
}

export class ReviewDto {
  /** The version being reviewed (the latest one). */
  @IsInt()
  @Min(1)
  versionNumber!: number;

  @ValidateNested()
  @Type(() => ScoresDto)
  scores!: ScoresDto;

  /** One thing the student did well. */
  @Transform(feedbackText)
  @IsString()
  @Length(1, 500)
  strength!: string;

  /** One thing to do next. */
  @Transform(feedbackText)
  @IsString()
  @Length(1, 500)
  nextStep!: string;

  @IsEnum(ReviewOutcome)
  outcome!: ReviewOutcome;

  /** Only with NEEDS_REVISION: days the student has to resubmit (default 7). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_REVISION_DAYS)
  revisionDays?: number;
}
EOF

# ============================================================================
cat > src/grading/grading-scope.service.ts <<'EOF'
/**
 * grading-scope.service.ts
 * ---------------------------------------------------------------------------
 * WHOSE submissions a person may see and review:
 *   - an admin: every cohort;
 *   - an instructor: only the cohorts assigned to her.
 * Checked against the database on every request (the same ownership rule as editing that
 * cohort's course), so removing an assignment takes effect on the next click.
 */
import { Injectable } from '@nestjs/common';
import { ContentKind, Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PolicyService } from '../auth/policy/policy.service';
import type { ManageResource } from '../course-content/content-editor.service';
import { COURSE_CONTENT_MANAGE } from '../course-content/course-content.constants';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GradingScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
  ) {}

  /** The cohorts this person may grade, or null for "all of them" (an admin). */
  async cohortIds(user: AuthenticatedUser): Promise<string[] | null> {
    if (user.role === Role.ADMIN) return null;
    const rows = await this.prisma.cohortInstructor.findMany({ where: { instructorId: user.id }, select: { cohortId: true } });
    return rows.map((row) => row.cohortId);
  }

  /** 403 unless this person may grade that cohort. */
  async assertCanGrade(user: AuthenticatedUser, cohortId: string): Promise<void> {
    await this.policy.assertCan<ManageResource>(user, COURSE_CONTENT_MANAGE, { kind: ContentKind.COHORT_COPY, cohortId });
  }
}
EOF

# ============================================================================
cat > src/grading/inbox.service.ts <<'EOF'
/**
 * inbox.service.ts
 * ---------------------------------------------------------------------------
 * The grading inbox: the submissions an instructor (or admin) can review.
 *
 *  - Default view: WAITING (sent, not yet reviewed), OLDEST FIRST, so nobody waits longest.
 *    Other views show the most recent activity first.
 *  - Filters: status, cohort, course, a date range (last activity, Chicago time), and a search
 *    by student name or receipt number. Results are paginated.
 *  - The tab counts always cover everything the person may see (not only the current page).
 *  - When nothing is waiting, "allCaughtUp" is true so the screen can say so.
 *  - Titles (assignment, week) come from the published course version the student answered.
 *  - Only the student's NAME is shown - never her contact or personal details.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, SubmissionStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { buildPage, toSkipTake } from '../common/pagination/pagination';
import { addDaysToLocalDate, zonedDateTimeToUtc } from '../common/utils/zoned-time';
import { branding } from '../config/branding.config';
import { PublishedCourseService } from '../learning/published-course.service';
import { PrismaService } from '../prisma/prisma.service';
import type { InboxQuery, InboxStatus } from './dto/inbox.query';
import { GradingScopeService } from './grading-scope.service';

const STATUS_OF: Record<InboxStatus, SubmissionStatus | null> = {
  WAITING: SubmissionStatus.SUBMITTED,
  NEEDS_REVISION: SubmissionStatus.NEEDS_REVISION,
  REVIEWED: SubmissionStatus.REVIEWED,
  COMPLETED: SubmissionStatus.COMPLETED,
  ALL: null,
};

export interface InboxCounts {
  waiting: number;
  needsRevision: number;
  reviewed: number;
  completed: number;
}

const NO_COUNTS: InboxCounts = { waiting: 0, needsRevision: 0, reviewed: 0, completed: 0 };

@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: GradingScopeService,
    private readonly published: PublishedCourseService,
  ) {}

  async list(user: AuthenticatedUser, query: InboxQuery) {
    const status: InboxStatus = query.status ?? 'WAITING';
    const cohortIds = await this.scope.cohortIds(user);

    // An instructor with no cohorts has nothing to review.
    if (cohortIds !== null && cohortIds.length === 0) {
      return { ...buildPage([], 0, query), status, counts: NO_COUNTS, allCaughtUp: true };
    }

    // What the person may see (and the narrowing she chose), without status / search / dates.
    const visible: Prisma.SubmissionWhereInput[] = [];
    if (cohortIds !== null) visible.push({ enrollment: { cohortId: { in: cohortIds } } });
    if (query.cohortId) visible.push({ enrollment: { cohortId: query.cohortId } });
    if (query.courseId) visible.push({ enrollment: { cohort: { courseId: query.courseId } } });

    const narrowing: Prisma.SubmissionWhereInput[] = [];
    const wanted = STATUS_OF[status];
    if (wanted) narrowing.push({ status: wanted });
    if (query.search) {
      narrowing.push({
        OR: [
          { reference: { contains: query.search, mode: 'insensitive' } },
          { enrollment: { student: { fullName: { contains: query.search, mode: 'insensitive' } } } },
        ],
      });
    }
    if (query.from || query.to) {
      narrowing.push({
        updatedAt: {
          ...(query.from ? { gte: zonedDateTimeToUtc(query.from, '00:00', branding.timezone) } : {}),
          // "to" is a whole day, so the range ends at the start of the next one.
          ...(query.to ? { lt: zonedDateTimeToUtc(addDaysToLocalDate(query.to, 1), '00:00', branding.timezone) } : {}),
        },
      });
    }
    const where: Prisma.SubmissionWhereInput = { AND: [...visible, ...narrowing] };

    const [total, rows, grouped] = await Promise.all([
      this.prisma.submission.count({ where }),
      this.prisma.submission.findMany({
        where,
        // Waiting: the longest wait first. Everything else: the latest activity first.
        orderBy: [{ updatedAt: status === 'WAITING' ? 'asc' : 'desc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: {
          id: true,
          reference: true,
          status: true,
          updatedAt: true,
          assignmentId: true,
          weekId: true,
          _count: { select: { versions: true } },
          versions: { orderBy: { number: 'desc' }, take: 1, select: { number: true, isLate: true, courseVersion: true, createdAt: true } },
          enrollment: {
            select: {
              student: { select: { id: true, fullName: true } },
              cohort: { select: { id: true, name: true, course: { select: { id: true, title: true } }, courseContent: { select: { id: true } } } },
            },
          },
        },
      }),
      this.prisma.submission.groupBy({ by: ['status'], where: { AND: visible }, _count: { _all: true } }),
    ]);

    const items = await Promise.all(
      rows.map(async (row) => {
        const latest = row.versions[0];
        const contentId = row.enrollment.cohort.courseContent?.id;

        // Titles from the course version the student answered.
        let assignmentTitle = 'Assignment';
        let week = { id: row.weekId, position: 0, title: '' };
        if (contentId && latest) {
          const snapshot = await this.published.get(contentId, latest.courseVersion);
          const index = snapshot.weeks.findIndex((candidate) => candidate.assignment?.id === row.assignmentId);
          if (index >= 0) {
            assignmentTitle = snapshot.weeks[index].assignment?.title ?? assignmentTitle;
            week = { id: snapshot.weeks[index].id, position: index + 1, title: snapshot.weeks[index].title };
          }
        }

        return {
          id: row.id,
          reference: row.reference,
          status: row.status,
          student: row.enrollment.student,
          cohort: { id: row.enrollment.cohort.id, name: row.enrollment.cohort.name },
          course: row.enrollment.cohort.course,
          assignment: { id: row.assignmentId, title: assignmentTitle },
          week,
          version: latest?.number ?? 1,
          versionCount: row._count.versions,
          isLate: latest?.isLate ?? false,
          submittedAt: latest?.createdAt ?? row.updatedAt,
          lastActivityAt: row.updatedAt,
        };
      }),
    );

    const counts = this.countsOf(grouped);
    return { ...buildPage(items, total, query), status, counts, allCaughtUp: counts.waiting === 0 };
  }

  /** The next submission waiting for review (the longest wait), or null. Used for "next in the queue". */
  async nextWaiting(user: AuthenticatedUser, excludeId?: string): Promise<{ id: string; reference: string } | null> {
    const cohortIds = await this.scope.cohortIds(user);
    if (cohortIds !== null && cohortIds.length === 0) return null;

    return this.prisma.submission.findFirst({
      where: {
        status: SubmissionStatus.SUBMITTED,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        ...(cohortIds !== null ? { enrollment: { cohortId: { in: cohortIds } } } : {}),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, reference: true },
    });
  }

  private countsOf(grouped: { status: SubmissionStatus; _count: { _all: number } }[]): InboxCounts {
    const counts = { ...NO_COUNTS };
    for (const row of grouped) {
      if (row.status === SubmissionStatus.SUBMITTED) counts.waiting = row._count._all;
      else if (row.status === SubmissionStatus.NEEDS_REVISION) counts.needsRevision = row._count._all;
      else if (row.status === SubmissionStatus.REVIEWED) counts.reviewed = row._count._all;
      else if (row.status === SubmissionStatus.COMPLETED) counts.completed = row._count._all;
    }
    return counts;
  }
}
EOF

# ============================================================================
cat > src/grading/reviews.service.ts <<'EOF'
/**
 * reviews.service.ts
 * ---------------------------------------------------------------------------
 * Looking at one submission, and reviewing it.
 *
 *  DETAIL  The student's name, the assignment as she was given it (with the FULL rubric, even
 *          when students cannot see it), the due and close times, every version with its note,
 *          link and files - the files open through short-lived links made for THIS instructor
 *          only - and each version's review.
 *
 *  REVIEW  Four rubric scores (1 to 4), one strength, one next step, and the outcome:
 *            REVIEWED         feedback given
 *            NEEDS_REVISION   she may resubmit for N days (7 by default), even after the deadline
 *            COMPLETED        done - she can no longer change it
 *          - Only the LATEST version can be reviewed. If the student sent a newer one while the
 *            instructor was reading, the save is refused (409) instead of landing on the wrong work.
 *          - One review per version. Its author can edit it for 24 hours (anyone else, or later, is
 *            refused). Every save and edit goes to the audit log; a review is never deleted.
 *          - The FIRST review of a week's assignment opens the next week for the student, when her
 *            lessons are complete (any outcome counts). The opening is recorded, so it stays open.
 *          - The answer includes the next submission in the queue.
 *
 * Who: admins, and the instructors of that student's cohort (checked on every request).
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EnrollmentStatus, SubmissionReview, SubmissionStatus } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { phaseAt, scheduleFor } from '../learning/assignment-rules';
import type { WeekProgress } from '../learning/learning-rules';
import { ProgressStateService } from '../learning/progress-state.service';
import { PublishedCourseService } from '../learning/published-course.service';
import { SubmissionFilesService } from '../learning/submission-files.service';
import type { ReviewDto } from './dto/review.dto';
import { GradingScopeService } from './grading-scope.service';
import { InboxService } from './inbox.service';
import { editDecision, revisionDaysFor } from './review-rules';

const DAY_MS = 86_400_000;

const scoresOf = (row: Pick<SubmissionReview, 'scoreUnderstanding' | 'scoreExecution' | 'scoreTesting' | 'scoreCommunication'>) => ({
  understanding: row.scoreUnderstanding,
  execution: row.scoreExecution,
  testing: row.scoreTesting,
  communication: row.scoreCommunication,
});

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: GradingScopeService,
    private readonly inbox: InboxService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
    private readonly files: SubmissionFilesService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ detail

  async detail(user: AuthenticatedUser, submissionId: string) {
    const row = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        reference: true,
        status: true,
        revisionOpenUntil: true,
        assignmentId: true,
        enrollment: {
          select: {
            student: { select: { id: true, fullName: true } },
            cohort: { select: { id: true, name: true, course: { select: { id: true, title: true } }, courseContent: { select: { id: true } } } },
          },
        },
        versions: {
          orderBy: { number: 'asc' },
          select: {
            number: true,
            isLate: true,
            courseVersion: true,
            linkUrl: true,
            note: true,
            createdAt: true,
            files: {
              orderBy: { position: 'asc' },
              select: { file: { select: { id: true, originalName: true, contentType: true, sizeBytes: true, storageKey: true } } },
            },
            review: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Submission not found.');
    await this.scope.assertCanGrade(user, row.enrollment.cohort.id);

    const latest = row.versions[row.versions.length - 1];
    const now = new Date();

    // The assignment exactly as the student was given it (the course version she answered).
    const contentId = row.enrollment.cohort.courseContent?.id;
    const snapshot = contentId && latest ? await this.published.get(contentId, latest.courseVersion) : null;
    const weekIndex = snapshot ? snapshot.weeks.findIndex((week) => week.assignment?.id === row.assignmentId) : -1;
    const week = snapshot && weekIndex >= 0 ? snapshot.weeks[weekIndex] : null;
    const assignment = week?.assignment ?? null;
    const schedule = scheduleFor(week?.classSession ? new Date(week.classSession.startsAt) : null);

    const reviewerIds = [...new Set(row.versions.flatMap((version) => (version.review ? [version.review.reviewerId] : [])))];
    const reviewers = reviewerIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, fullName: true } })
      : [];
    const reviewerName = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer.fullName]));

    return {
      id: row.id,
      reference: row.reference,
      status: row.status,
      revisionOpenUntil: row.revisionOpenUntil,
      student: row.enrollment.student,
      cohort: { id: row.enrollment.cohort.id, name: row.enrollment.cohort.name },
      course: row.enrollment.cohort.course,
      assignment: assignment
        ? {
            id: assignment.id,
            title: assignment.title,
            brief: assignment.brief,
            includes: assignment.includes,
            successEvidence: assignment.successEvidence,
            expectedMinutes: assignment.expectedMinutes,
            allowedFileTypes: assignment.allowedFileTypes,
            // Instructors always see the whole rubric; this says whether the STUDENT can.
            rubric: assignment.rubric,
            rubricVisibleToStudent: assignment.rubricVisible,
          }
        : { id: row.assignmentId, title: 'Assignment' },
      week: week ? { id: week.id, position: weekIndex + 1, title: week.title } : null,
      schedule: {
        timezone: schedule.timezone,
        dueAt: schedule.dueAt,
        closesAt: schedule.closesAt,
        phase: phaseAt(schedule, now),
      },
      versions: row.versions.map((version) => ({
        number: version.number,
        submittedAt: version.createdAt,
        isLate: version.isLate,
        courseVersion: version.courseVersion,
        linkUrl: version.linkUrl,
        note: version.note,
        // Links made for THIS instructor only; they work for a few minutes.
        files: version.files.map(({ file }) => ({
          id: file.id,
          name: file.originalName,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          url: this.files.linkFor(file, user.id),
        })),
        review: version.review ? this.reviewView(version.review, reviewerName.get(version.review.reviewerId) ?? 'Unknown', user, now) : null,
      })),
      latestVersion: latest?.number ?? 0,
      nextInQueue: await this.inbox.nextWaiting(user, row.id),
    };
  }

  // -------------------------------------------------------------------- save

  async save(user: AuthenticatedUser, submissionId: string, dto: ReviewDto, requestContext: RequestContext) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        enrollment: {
          select: { id: true, status: true, cohort: { select: { id: true, courseContent: { select: { id: true, publishedVersion: true } } } } },
        },
      },
    });
    if (!submission) throw new NotFoundException('Submission not found.');
    const { enrollment } = submission;
    await this.scope.assertCanGrade(user, enrollment.cohort.id);

    const revision = revisionDaysFor(dto.outcome, dto.revisionDays);
    if (revision.problem) throw new BadRequestException(revision.problem);

    // The live course, to work out which week this review opens (none if nothing is published).
    const content = enrollment.cohort.courseContent;
    const live = content && content.publishedVersion !== null ? await this.published.get(content.id, content.publishedVersion) : null;

    const saved = await this.prisma.$transaction(async (tx) => {
      // Take turns with the student (a new version) and with other reviewers.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "submissions" WHERE "id" = ${submissionId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Submission not found.');

      const current = await tx.submission.findUniqueOrThrow({
        where: { id: submissionId },
        select: { versions: { orderBy: { number: 'desc' }, take: 1, select: { number: true } } },
      });
      const latest = current.versions[0]?.number;
      if (latest === undefined) throw new ConflictException('This submission has no versions to review.');
      if (dto.versionNumber > latest) throw new NotFoundException(`Version ${dto.versionNumber} not found.`);
      if (dto.versionNumber < latest) throw new ConflictException('The student sent a newer version. Reload and review the latest one.');

      const existing = await tx.submissionReview.findUnique({
        where: { submissionId_versionNumber: { submissionId, versionNumber: latest } },
      });
      const now = new Date();
      if (existing) {
        const decision = editDecision({ reviewerId: existing.reviewerId, userId: user.id, createdAt: existing.createdAt, now });
        if (!decision.allowed) {
          if (decision.blockedBy === 'AUTHOR') throw new ForbiddenException(decision.reason);
          throw new ConflictException(decision.reason);
        }
      }

      // Which weeks are open BEFORE this review counts.
      const learning = live !== null && enrollment.status === EnrollmentStatus.ACTIVE ? live : null;
      const before = learning ? this.progress.evaluate(learning, await this.progress.load(tx, enrollment.id, learning)) : null;

      const data = {
        scoreUnderstanding: dto.scores.understanding,
        scoreExecution: dto.scores.execution,
        scoreTesting: dto.scores.testing,
        scoreCommunication: dto.scores.communication,
        strength: dto.strength,
        nextStep: dto.nextStep,
        outcome: dto.outcome,
        revisionDays: revision.days,
      };
      const review = existing
        ? await tx.submissionReview.update({ where: { id: existing.id }, data: { ...data, editedAt: now } })
        : await tx.submissionReview.create({ data: { submissionId, versionNumber: latest, reviewerId: user.id, ...data } });

      const updated = await tx.submission.update({
        where: { id: submissionId },
        data: {
          status: SubmissionStatus[dto.outcome],
          revisionOpenUntil: revision.days ? new Date(now.getTime() + revision.days * DAY_MS) : null,
        },
        select: { reference: true, status: true, revisionOpenUntil: true },
      });

      // The first review opens the next week (when her lessons are complete); remember it.
      let opened: WeekProgress[] = [];
      if (learning && before) {
        const after = this.progress.evaluate(learning, await this.progress.load(tx, enrollment.id, learning));
        opened = await this.progress.recordOpenings(tx, enrollment.id, before, after);
      }

      await this.audit.record(
        {
          actorId: user.id,
          action: existing ? 'submission.review_edited' : 'submission.reviewed',
          entityType: 'submission',
          entityId: submissionId,
          metadata: { version: latest, outcome: dto.outcome, openedWeeks: opened.map((week) => week.position) },
          previousValue: existing ? { outcome: existing.outcome, scores: scoresOf(existing) } : undefined,
          newValue: { outcome: review.outcome, scores: scoresOf(review) },
          ipAddress: requestContext.ipAddress,
        },
        tx,
      );

      return { review, updated, opened, edited: existing !== null };
    });

    return {
      edited: saved.edited,
      review: this.reviewView(saved.review, user.fullName, user, new Date()),
      submission: { id: submissionId, reference: saved.updated.reference, status: saved.updated.status, revisionOpenUntil: saved.updated.revisionOpenUntil },
      openedWeeks: saved.opened.map((week) => ({ id: week.id, position: week.position, title: week.title })),
      nextInQueue: await this.inbox.nextWaiting(user, submissionId),
    };
  }

  // ----------------------------------------------------------------- helpers

  private reviewView(review: SubmissionReview, reviewerName: string, user: AuthenticatedUser, now: Date) {
    return {
      id: review.id,
      versionNumber: review.versionNumber,
      scores: scoresOf(review),
      strength: review.strength,
      nextStep: review.nextStep,
      outcome: review.outcome,
      revisionDays: review.revisionDays,
      reviewedAt: review.createdAt,
      editedAt: review.editedAt,
      reviewer: { id: review.reviewerId, fullName: reviewerName },
      /** true while this person is the author and the 24 hours have not passed. */
      canEdit: editDecision({ reviewerId: review.reviewerId, userId: user.id, createdAt: review.createdAt, now }).allowed,
    };
  }
}
EOF

# ============================================================================
cat > src/grading/grading.controller.ts <<'EOF'
/**
 * grading.controller.ts
 * ---------------------------------------------------------------------------
 * Reviewing student work. Admins and instructors use the SAME addresses; WHICH submissions a
 * person may see is decided on every request (an instructor only gets her own cohorts').
 *
 *   GET /api/v1/grading/inbox                              the submissions waiting for review (filters, search, pages)
 *   GET /api/v1/grading/submissions/:submissionId          one submission: versions, files, rubric, reviews
 *   PUT /api/v1/grading/submissions/:submissionId/review   save (or, within 24 hours, edit) a review
 *                                                           -> answers with the next submission in the queue
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { InboxQuery } from './dto/inbox.query';
import { ReviewDto } from './dto/review.dto';
import { InboxService } from './inbox.service';
import { ReviewsService } from './reviews.service';

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('grading')
export class GradingController {
  constructor(
    private readonly inbox: InboxService,
    private readonly reviews: ReviewsService,
  ) {}

  @Get('inbox')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: InboxQuery) {
    return this.inbox.list(user, query);
  }

  @Get('submissions/:submissionId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('submissionId', new ParseUUIDPipe()) submissionId: string) {
    return this.reviews.detail(user, submissionId);
  }

  @Put('submissions/:submissionId/review')
  @HttpCode(200)
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Param('submissionId', new ParseUUIDPipe()) submissionId: string,
    @Body() dto: ReviewDto,
    @Req() req: Request,
  ) {
    return this.reviews.save(user, submissionId, dto, getRequestContext(req));
  }
}
EOF

cat > src/grading/grading.module.ts <<'EOF'
/**
 * grading.module.ts
 * ---------------------------------------------------------------------------
 * Reviewing student work: the inbox, one submission's detail, and saving reviews.
 *
 * It relies on the ownership rule registered by CourseContentModule ("course-content.manage")
 * to decide whose submissions an instructor may review, and on the learning module for the
 * shared progress rules and for opening submitted files.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { LearningModule } from '../learning/learning.module';
import { GradingController } from './grading.controller';
import { GradingScopeService } from './grading-scope.service';
import { InboxService } from './inbox.service';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [AuthModule, LearningModule],
  controllers: [GradingController],
  providers: [GradingScopeService, InboxService, ReviewsService],
})
export class GradingModule {}
EOF

# ============================================================================
# Changed files (rewritten in full)
cat > src/learning/assignment-context.service.ts <<'EOF'
/**
 * assignment-context.service.ts
 * ---------------------------------------------------------------------------
 * What every student assignment action needs first:
 *   requireReady()  which course she may open right now (or the plain-English reason she cannot);
 *   load()          the live published course and which weeks are open for her.
 * Shared by the assignment screens and by submitting, so the rules are written once.
 */
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { formatCalendarDate } from '../catalog/catalog.util';
import type { Snapshot } from '../course-content/snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { LearningAccessService, LearningContext } from './learning-access.service';
import type { WeekProgress } from './learning-rules';
import { cohortNotStartedMessage, NOT_OPEN_MESSAGE, NOT_READY_MESSAGE } from './learning.constants';
import { ProgressStateService } from './progress-state.service';
import { PublishedCourseService } from './published-course.service';

@Injectable()
export class AssignmentContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
  ) {}

  async requireReady(user: AuthenticatedUser): Promise<LearningContext> {
    const access = await this.access.resolve(user);
    switch (access.kind) {
      case 'READY':
        return access.context;
      case 'NOT_STARTED':
        throw new ForbiddenException(cohortNotStartedMessage(formatCalendarDate(access.cohort.startsOn)));
      case 'NOT_READY':
        throw new ConflictException(NOT_READY_MESSAGE);
      default:
        throw new ForbiddenException(NOT_OPEN_MESSAGE);
    }
  }

  async load(context: LearningContext): Promise<{ snapshot: Snapshot; weeks: WeekProgress[] }> {
    const snapshot = await this.published.get(context.contentId, context.version);
    const state = await this.progress.load(this.prisma, context.enrollmentId, snapshot);
    return { snapshot, weeks: this.progress.evaluate(snapshot, state, context.readOnly) };
  }
}
EOF

cat > src/learning/learning.module.ts <<'EOF'
/**
 * learning.module.ts
 * ---------------------------------------------------------------------------
 * The student's learning experience: the course overview, lessons, completion,
 * video resume, assignments and submissions, and opening a week early for one student.
 *
 * It relies on the ownership rule registered by CourseContentModule
 * ("course-content.manage") for the early-open action, so both modules must be
 * part of the application (they are, in AppModule). File storage and signed links come
 * from the shared PlatformModule (src/platform), which is global.
 *
 * ProgressStateService, PublishedCourseService and SubmissionFilesService are exported
 * because the grading module uses them too.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AssignmentContextService } from './assignment-context.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { EnrollmentUnlockController } from './enrollment-unlock.controller';
import { LearningAccessService } from './learning-access.service';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { ProgressStateService } from './progress-state.service';
import { PublishedCourseService } from './published-course.service';
import { SubmissionFilesService } from './submission-files.service';
import { SubmissionsService } from './submissions.service';
import { WeekUnlockService } from './week-unlock.service';

@Module({
  imports: [AuthModule],
  controllers: [LearningController, AssignmentsController, EnrollmentUnlockController],
  providers: [
    LearningAccessService,
    PublishedCourseService,
    ProgressStateService,
    LearningService,
    AssignmentContextService,
    AssignmentsService,
    SubmissionFilesService,
    SubmissionsService,
    WeekUnlockService,
  ],
  exports: [PublishedCourseService, ProgressStateService, SubmissionFilesService],
})
export class LearningModule {}
EOF

echo "Batch 4C-1 files created. Now replace the files shown below the script."