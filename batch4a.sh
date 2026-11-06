#!/usr/bin/env bash
# Batch 4A - assignments and live class sessions inside the course content. Run from the repo root.
set -euo pipefail
cd backend
mkdir -p prisma/migrations/20261101000000_course_assignments src/common/utils src/course-content/dto src/learning

# ============================================================================
cat > prisma/migrations/20261101000000_course_assignments/migration.sql <<'EOF'
-- Batch 4A: assignments and live class sessions inside the course content.
--
--   course_assignments     at most ONE assignment per week: the brief, what to include, the file
--                          types allowed, and the four-criterion rubric.
--   course_class_sessions  at most ONE live class per week (its date and time). The assignment's
--                          due date is worked out from it (3 days after class, 5 PM Central).
--
-- Both belong to a week of a course copy, so they are part of the DRAFT, are frozen into every
-- published version, and are replaced together with the rest when a version is restored.
-- A week and its assignment can never belong to different course copies (composite link).
-- Written by hand (CHECK rules and triggers); names follow Prisma's conventions.

-- ---------------------------------------------------------------------------
CREATE TABLE "course_assignments" (
  "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
  "content_id"         UUID           NOT NULL,
  "week_id"            UUID           NOT NULL,
  "title"              VARCHAR(150)   NOT NULL,
  "brief"              VARCHAR(5000)  NOT NULL,
  "includes"           TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],
  "success_evidence"   VARCHAR(1000),
  "expected_minutes"   INTEGER,
  "allowed_file_types" TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rubric"             JSONB          NOT NULL,
  "rubric_visible"     BOOLEAN        NOT NULL DEFAULT true,
  "origin_id"          UUID,
  "revision"           INTEGER        NOT NULL DEFAULT 1,
  "edited_by_id"       UUID,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "course_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_assignments_title_check"    CHECK (btrim("title") <> ''),
  CONSTRAINT "course_assignments_brief_check"    CHECK (btrim("brief") <> ''),
  CONSTRAINT "course_assignments_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "course_assignments_minutes_check"  CHECK ("expected_minutes" IS NULL OR "expected_minutes" BETWEEN 1 AND 600),
  CONSTRAINT "course_assignments_includes_check" CHECK (cardinality("includes") <= 10),
  CONSTRAINT "course_assignments_rubric_check"   CHECK (jsonb_typeof("rubric") = 'object'),
  -- Only these file types can ever be allowed (the same list the code uses).
  CONSTRAINT "course_assignments_file_types_check"
    CHECK ("allowed_file_types" <@ ARRAY['pdf','png','jpg','docx','pptx','zip','ino','py']::TEXT[])
);

CREATE UNIQUE INDEX "course_assignments_week_id_content_id_key" ON "course_assignments"("week_id", "content_id");
CREATE INDEX "course_assignments_content_id_idx" ON "course_assignments"("content_id");

ALTER TABLE "course_assignments"
  ADD CONSTRAINT "course_assignments_week_id_content_id_fkey"
    FOREIGN KEY ("week_id", "content_id") REFERENCES "course_weeks"("id", "content_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
CREATE TABLE "course_class_sessions" (
  "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
  "content_id"       UUID           NOT NULL,
  "week_id"          UUID           NOT NULL,
  "starts_at"        TIMESTAMPTZ(3) NOT NULL,
  "duration_minutes" INTEGER        NOT NULL,
  "join_url"         VARCHAR(2000),
  "notes"            VARCHAR(500),
  "origin_id"        UUID,
  "revision"         INTEGER        NOT NULL DEFAULT 1,
  "edited_by_id"     UUID,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "course_class_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_class_sessions_duration_check" CHECK ("duration_minutes" BETWEEN 15 AND 480),
  CONSTRAINT "course_class_sessions_revision_check" CHECK ("revision" >= 1)
);

CREATE UNIQUE INDEX "course_class_sessions_week_id_content_id_key" ON "course_class_sessions"("week_id", "content_id");
CREATE INDEX "course_class_sessions_content_id_idx" ON "course_class_sessions"("content_id");

ALTER TABLE "course_class_sessions"
  ADD CONSTRAINT "course_class_sessions_week_id_content_id_fkey"
    FOREIGN KEY ("week_id", "content_id") REFERENCES "course_weeks"("id", "content_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- "Last edited by": the same trigger the weeks, lessons and blocks use (Batch 2B-1).
-- ---------------------------------------------------------------------------
CREATE TRIGGER "course_assignments_stamp_editor"
  BEFORE INSERT OR UPDATE ON "course_assignments"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
CREATE TRIGGER "course_class_sessions_stamp_editor"
  BEFORE INSERT OR UPDATE ON "course_class_sessions"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
EOF

# ============================================================================
cat > src/common/utils/zoned-time.ts <<'EOF'
/**
 * zoned-time.ts
 * ---------------------------------------------------------------------------
 * Working with a wall-clock time in a named timezone (the programme's zone is
 * America/Chicago), correctly across daylight saving changes.
 *
 * Plain-English rule used everywhere: a moment in time is STORED as an exact
 * instant (UTC). When a rule is about "5:00 PM on a calendar day in Chicago", it is
 * worked out here, so "5 PM" stays 5 PM Chicago time in winter and in summer.
 *
 *   zonedDateTimeToUtc('2026-10-09', '17:00', zone)  ->  the instant it is 5 PM that day in that zone
 *   localParts(instant, zone)                        ->  { date: '2026-10-09', time: '17:00' } in that zone
 *   addDaysToLocalDate('2026-10-09', 7)              ->  '2026-10-16'  (calendar days, no clock involved)
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let existing = formatters.get(zone);
  if (!existing) {
    existing = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, existing);
  }
  return existing;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsOf(instant: Date, zone: string): Parts {
  const found = formatter(zone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(found.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

/** How far ahead of UTC the zone's wall clock is at this instant (negative for Chicago), in milliseconds. */
function offsetMs(instant: Date, zone: string): number {
  const p = partsOf(instant, zone);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The exact instant at which the wall clock in `zone` shows this date and time ("YYYY-MM-DD", "HH:mm"). */
export function zonedDateTimeToUtc(date: string, time: string, zone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);

  // Take the zone's offset near that moment, then check it again at the result:
  // the two differ only when a daylight saving change falls in between.
  const first = offsetMs(new Date(wallClockAsUtc), zone);
  let result = wallClockAsUtc - first;
  const second = offsetMs(new Date(result), zone);
  if (second !== first) result = wallClockAsUtc - second;
  return new Date(result);
}

/** The calendar date and the clock time an instant has in the zone. */
export function localParts(instant: Date, zone: string): { date: string; time: string } {
  const p = partsOf(instant, zone);
  const two = (n: number) => String(n).padStart(2, '0');
  return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, time: `${two(p.hour)}:${two(p.minute)}` };
}

/** Adds (or subtracts) whole calendar days to "YYYY-MM-DD". */
export function addDaysToLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
EOF

# ============================================================================
cat > src/course-content/assignment-data.ts <<'EOF'
/**
 * assignment-data.ts
 * ---------------------------------------------------------------------------
 * Checks and cleans an assignment (and its rubric) before it is saved. Pure
 * functions, so they are easy to test on their own.
 *
 * An assignment has: a title, the brief shown to students, a numbered "what to
 * include" list, optional "success evidence" and expected time, the file types a
 * student may upload (a link and a written note are always accepted), and a rubric.
 *
 * THE RUBRIC always has the same four criteria, in this order:
 *     Understanding, Practical execution, Testing and improvement, Communication
 * Each is scored 1 to 4, and each score has a short description that the instructor can
 * edit (stored as { criteria: [ { key, name, levels: [ { score, description } ] } ] }).
 *
 * Every problem is reported together, so the person fixes them in one go.
 */
import { BadRequestException } from '@nestjs/common';

import { cleanLabel } from '../catalog/catalog.util';

/** The only file types an assignment may allow (also enforced by the database). */
export const ALLOWED_FILE_TYPES = ['pdf', 'png', 'jpg', 'docx', 'pptx', 'zip', 'ino', 'py'] as const;
export type FileType = (typeof ALLOWED_FILE_TYPES)[number];

/** Used when a new assignment does not say. */
export const DEFAULT_FILE_TYPES: FileType[] = ['pdf', 'png', 'jpg', 'zip'];

export const RUBRIC_CRITERIA = [
  { key: 'understanding', name: 'Understanding' },
  { key: 'execution', name: 'Practical execution' },
  { key: 'testing', name: 'Testing and improvement' },
  { key: 'communication', name: 'Communication' },
] as const;

const DEFAULT_LEVELS = ['Needs a lot of support', 'Getting there', 'Meets the goal', 'Goes beyond the goal'];

export interface RubricLevel {
  score: number;
  description: string;
}
export interface RubricCriterion {
  key: string;
  name: string;
  levels: RubricLevel[];
}
export interface Rubric {
  criteria: RubricCriterion[];
}

export function defaultRubric(): Rubric {
  return {
    criteria: RUBRIC_CRITERIA.map((criterion) => ({
      key: criterion.key,
      name: criterion.name,
      levels: DEFAULT_LEVELS.map((description, index) => ({ score: index + 1, description })),
    })),
  };
}

export const MAX_INCLUDES = 10;
const LIMITS = { title: 150, brief: 5_000, include: 300, evidence: 1_000, minutes: 600, level: 300 };

/** What the screen may send. Everything is optional here; creating needs a title and a brief. */
export interface AssignmentInput {
  title?: unknown;
  brief?: unknown;
  includes?: unknown;
  successEvidence?: unknown;
  expectedMinutes?: unknown;
  allowedFileTypes?: unknown;
  rubric?: unknown;
  rubricVisible?: unknown;
}

/** An assignment as it is stored. */
export interface AssignmentValues {
  title: string;
  brief: string;
  includes: string[];
  successEvidence: string | null;
  expectedMinutes: number | null;
  allowedFileTypes: FileType[];
  rubric: Rubric;
  rubricVisible: boolean;
}

/** Checks a rubric sent by the screen: exactly the four criteria, four descriptions each. */
function normalizeRubric(input: unknown, problems: string[]): Rubric | undefined {
  const source = input as { criteria?: unknown } | null;
  if (!source || typeof source !== 'object' || !Array.isArray(source.criteria)) {
    problems.push('rubric must look like { criteria: [ { key, levels: [four descriptions] } ] }.');
    return undefined;
  }

  const byKey = new Map<string, unknown>();
  for (const item of source.criteria as { key?: unknown; levels?: unknown }[]) {
    if (!item || typeof item !== 'object' || typeof item.key !== 'string') {
      problems.push('Every rubric criterion needs a key.');
      return undefined;
    }
    if (byKey.has(item.key)) problems.push(`rubric lists "${item.key}" twice.`);
    byKey.set(item.key, item.levels);
  }

  const known = new Set<string>(RUBRIC_CRITERIA.map((criterion) => criterion.key));
  for (const key of byKey.keys()) {
    if (!known.has(key)) problems.push(`"${key}" is not a rubric criterion. Use: ${[...known].join(', ')}.`);
  }

  const criteria: RubricCriterion[] = [];
  for (const criterion of RUBRIC_CRITERIA) {
    const levels = byKey.get(criterion.key);
    if (!Array.isArray(levels) || levels.length !== 4) {
      problems.push(`${criterion.name} needs exactly four level descriptions (scores 1 to 4).`);
      continue;
    }

    const described: RubricLevel[] = [];
    levels.forEach((level: unknown, index: number) => {
      const text = typeof level === 'string' ? cleanLabel(level) : '';
      if (text === '' || text.length > LIMITS.level) {
        problems.push(`${criterion.name}, score ${index + 1}: write a description of 1 to ${LIMITS.level} characters.`);
      } else {
        described.push({ score: index + 1, description: text });
      }
    });
    criteria.push({ key: criterion.key, name: criterion.name, levels: described });
  }

  return problems.length === 0 ? { criteria } : undefined;
}

/**
 * Builds the assignment to store from what was sent and what exists now.
 *   - creating (current = null): a title and a brief are required, everything else has a default;
 *   - updating: only the fields that were sent change; the rest keep their value.
 * Throws a 400 listing every problem.
 */
export function buildAssignment(input: AssignmentInput, current: AssignmentValues | null): AssignmentValues {
  const problems: string[] = [];
  const sent = (value: unknown): boolean => value !== undefined;

  // --- title and brief
  let title = current?.title;
  if (sent(input.title)) {
    const text = typeof input.title === 'string' ? cleanLabel(input.title) : '';
    if (text.length < 2 || text.length > LIMITS.title) problems.push(`title must be 2 to ${LIMITS.title} characters.`);
    else title = text;
  } else if (!current) problems.push('title is required.');

  let brief = current?.brief;
  if (sent(input.brief)) {
    const text = typeof input.brief === 'string' ? input.brief.replace(/\r\n?/g, '\n').trim() : '';
    if (text.length < 10 || text.length > LIMITS.brief) problems.push(`brief must be 10 to ${LIMITS.brief} characters.`);
    else brief = text;
  } else if (!current) problems.push('brief is required.');

  // --- "what to include" list
  let includes = current?.includes ?? [];
  if (sent(input.includes)) {
    if (!Array.isArray(input.includes) || input.includes.length > MAX_INCLUDES) {
      problems.push(`includes must be a list of at most ${MAX_INCLUDES} items.`);
    } else {
      const items = (input.includes as unknown[]).map((item) => (typeof item === 'string' ? cleanLabel(item) : ''));
      if (items.some((item) => item === '' || item.length > LIMITS.include)) {
        problems.push(`every item in includes must be 1 to ${LIMITS.include} characters.`);
      } else includes = items;
    }
  }

  // --- success evidence (null or empty clears it)
  let successEvidence = current?.successEvidence ?? null;
  if (sent(input.successEvidence)) {
    if (input.successEvidence === null || input.successEvidence === '') successEvidence = null;
    else if (typeof input.successEvidence !== 'string' || input.successEvidence.trim().length > LIMITS.evidence) {
      problems.push(`successEvidence must be text of at most ${LIMITS.evidence} characters.`);
    } else successEvidence = input.successEvidence.replace(/\r\n?/g, '\n').trim();
  }

  // --- expected time (null clears it)
  let expectedMinutes = current?.expectedMinutes ?? null;
  if (sent(input.expectedMinutes)) {
    const minutes = input.expectedMinutes;
    if (minutes === null) expectedMinutes = null;
    else if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > LIMITS.minutes) {
      problems.push(`expectedMinutes must be a whole number from 1 to ${LIMITS.minutes}.`);
    } else expectedMinutes = minutes;
  }

  // --- allowed file types
  let allowedFileTypes: FileType[] = current?.allowedFileTypes ?? DEFAULT_FILE_TYPES;
  if (sent(input.allowedFileTypes)) {
    const types = Array.isArray(input.allowedFileTypes)
      ? (input.allowedFileTypes as unknown[]).map((type) => (typeof type === 'string' ? type.trim().toLowerCase().replace(/^\./, '') : ''))
      : null;
    const known = new Set<string>(ALLOWED_FILE_TYPES);
    if (!types || types.some((type) => !known.has(type))) {
      problems.push(`allowedFileTypes must be a list from: ${ALLOWED_FILE_TYPES.join(', ')}.`);
    } else allowedFileTypes = [...new Set(types)] as FileType[];
  }

  // --- rubric
  let rubric = current?.rubric ?? defaultRubric();
  if (sent(input.rubric)) {
    const normalized = normalizeRubric(input.rubric, problems);
    if (normalized) rubric = normalized;
  }

  // --- rubric visible to students
  let rubricVisible = current?.rubricVisible ?? true;
  if (sent(input.rubricVisible)) {
    if (typeof input.rubricVisible !== 'boolean') problems.push('rubricVisible must be true or false.');
    else rubricVisible = input.rubricVisible;
  }

  if (problems.length > 0) throw new BadRequestException(problems);
  return {
    title: title as string,
    brief: brief as string,
    includes,
    successEvidence,
    expectedMinutes,
    allowedFileTypes,
    rubric,
    rubricVisible,
  };
}
EOF

# ============================================================================
cat > src/course-content/dto/assignment.dto.ts <<'EOF'
/**
 * assignment.dto.ts - what the screen may send when saving a week's assignment.
 *
 * Send only the fields to set. When the week has no assignment yet, `title` and
 * `brief` are required and everything else gets a default. The fields are checked in
 * detail by assignment-data.ts. `null` clears successEvidence and expectedMinutes.
 */
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class SaveAssignmentDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  brief?: string;

  /** The numbered "What to include" list (up to 10 short items). */
  @IsOptional()
  @IsArray()
  includes?: string[];

  @IsOptional()
  @IsString()
  successEvidence?: string | null;

  @IsOptional()
  @IsInt()
  expectedMinutes?: number | null;

  /** From: pdf, png, jpg, docx, pptx, zip, ino, py. (A link and a written note are always accepted.) */
  @IsOptional()
  @IsArray()
  allowedFileTypes?: string[];

  /** { criteria: [ { key, levels: [four descriptions] } ] } for all four criteria. */
  @IsOptional()
  @IsObject()
  rubric?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  rubricVisible?: boolean;

  /** The revision the screen was showing (when editing). If someone saved since, the edit is refused. */
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
EOF

cat > src/course-content/dto/class-session.dto.ts <<'EOF'
/**
 * class-session.dto.ts - the live class of a week. The date and time are entered as
 * Chicago time (the programme's timezone), exactly as the instructor sees them.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import { IsCalendarDate } from '../../common/validation/calendar-date.decorator';

const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class SaveClassSessionDto {
  /** The day of the class, "YYYY-MM-DD". */
  @IsCalendarDate()
  date!: string;

  /** The start time, "HH:mm" (24-hour, Chicago time). */
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'time must look like 17:00 (24-hour, Chicago time).' })
  time!: string;

  @IsInt()
  @Min(15)
  @Max(480)
  durationMinutes!: number;

  /** Where students join (a web link). Empty clears it. */
  @IsOptional()
  @Transform(textOrNull)
  @IsString()
  @MaxLength(2000)
  joinUrl?: string | null;

  @IsOptional()
  @Transform(textOrNull)
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
EOF

# ============================================================================
cat > src/course-content/course-planning.service.ts <<'EOF'
/**
 * course-planning.service.ts
 * ---------------------------------------------------------------------------
 * What a week PLANS besides its lessons: its assignment (with the rubric) and its
 * live class (date and time).
 *
 *  - At most ONE assignment and ONE live class per week (the database enforces it).
 *  - Both are part of the DRAFT: they go through the same gatekeeper as lessons
 *    (permissions, one editor at a time, "last edited by", closed cohorts and archived
 *    courses are frozen) and they are frozen into every published version.
 *  - The class date and time are entered in Chicago time and stored as an exact instant.
 *    The assignment's due date is NOT stored: it is worked out from the class (3 days
 *    after class at 5:00 PM Central), so moving the class moves the due date with it.
 *  - Removing an assignment is written to the audit log (ids only, never the text).
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CourseAssignment, CourseClassSession, Prisma } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import type { DbClient } from '../common/types/db-client';
import { localParts, zonedDateTimeToUtc } from '../common/utils/zoned-time';
import { branding } from '../config/branding.config';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentValues, buildAssignment, FileType, Rubric } from './assignment-data';
import { parseHttpUrl } from './block-data';
import { ContentEditor } from './content-editor.service';
import type { SaveAssignmentDto } from './dto/assignment.dto';
import type { SaveClassSessionDto } from './dto/class-session.dto';
import { assertFreshRevision } from './editing-helpers';

@Injectable()
export class CoursePlanningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly editor: ContentEditor,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- reading

  /** A week's assignment and live class together (what the week editor loads). */
  async getPlanning(user: AuthenticatedUser, contentId: string, weekId: string) {
    await this.editor.open(user, contentId);
    await this.requireWeek(this.prisma, contentId, weekId);

    const [assignment, session] = await Promise.all([
      this.prisma.courseAssignment.findUnique({ where: { weekId_contentId: { weekId, contentId } } }),
      this.prisma.courseClassSession.findUnique({ where: { weekId_contentId: { weekId, contentId } } }),
    ]);
    return {
      assignment: assignment ? this.assignmentView(assignment) : null,
      classSession: session ? this.sessionView(session) : null,
    };
  }

  // -------------------------------------------------------------- assignment

  /** Creates or updates the week's assignment (see SaveAssignmentDto). */
  async saveAssignment(user: AuthenticatedUser, contentId: string, weekId: string, dto: SaveAssignmentDto) {
    return this.editor.edit(user, contentId, async (tx) => {
      await this.requireWeek(tx, contentId, weekId);

      const existing = await tx.courseAssignment.findUnique({ where: { weekId_contentId: { weekId, contentId } } });
      if (existing) assertFreshRevision(existing.revision, dto.expectedRevision, 'assignment');

      const values = buildAssignment(dto, existing ? this.toValues(existing) : null);
      const data = {
        title: values.title,
        brief: values.brief,
        includes: values.includes,
        successEvidence: values.successEvidence,
        expectedMinutes: values.expectedMinutes,
        allowedFileTypes: values.allowedFileTypes,
        rubric: values.rubric as unknown as Prisma.InputJsonObject,
        rubricVisible: values.rubricVisible,
      };

      const saved = existing
        ? await tx.courseAssignment.update({ where: { id: existing.id }, data: { ...data, revision: { increment: 1 } } })
        : await tx.courseAssignment.create({ data: { contentId, weekId, ...data } });
      return { assignment: this.assignmentView(saved) };
    });
  }

  async removeAssignment(user: AuthenticatedUser, contentId: string, weekId: string, context: RequestContext) {
    return this.editor.edit(user, contentId, async (tx) => {
      await this.requireWeek(tx, contentId, weekId);

      const removed = await tx.courseAssignment.deleteMany({ where: { weekId, contentId } });
      if (removed.count === 0) throw new NotFoundException('This week has no assignment.');

      await this.audit.record(
        {
          actorId: user.id,
          action: 'course_content.assignment_removed',
          entityType: 'course_content',
          entityId: contentId,
          metadata: { weekId },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { removed: true as const };
    });
  }

  // ------------------------------------------------------------ live class

  /** Sets the week's live class. Date and time are Chicago time. */
  async saveClassSession(user: AuthenticatedUser, contentId: string, weekId: string, dto: SaveClassSessionDto) {
    const problems: string[] = [];
    let joinUrl: string | null = null;
    if (dto.joinUrl) {
      const parsed = parseHttpUrl(dto.joinUrl);
      if (parsed) joinUrl = parsed.href;
      else problems.push('joinUrl must be a web address starting with http:// or https://.');
    }
    if (problems.length > 0) throw new BadRequestException(problems);

    const startsAt = zonedDateTimeToUtc(dto.date, dto.time, branding.timezone);

    return this.editor.edit(user, contentId, async (tx) => {
      await this.requireWeek(tx, contentId, weekId);

      const existing = await tx.courseClassSession.findUnique({ where: { weekId_contentId: { weekId, contentId } } });
      if (existing) assertFreshRevision(existing.revision, dto.expectedRevision, 'class session');

      const data = { startsAt, durationMinutes: dto.durationMinutes, joinUrl, notes: dto.notes ?? null };
      const saved = existing
        ? await tx.courseClassSession.update({ where: { id: existing.id }, data: { ...data, revision: { increment: 1 } } })
        : await tx.courseClassSession.create({ data: { contentId, weekId, ...data } });
      return { classSession: this.sessionView(saved) };
    });
  }

  async removeClassSession(user: AuthenticatedUser, contentId: string, weekId: string) {
    return this.editor.edit(user, contentId, async (tx) => {
      await this.requireWeek(tx, contentId, weekId);

      const removed = await tx.courseClassSession.deleteMany({ where: { weekId, contentId } });
      if (removed.count === 0) throw new NotFoundException('This week has no live class.');
      return { removed: true as const };
    });
  }

  // ----------------------------------------------------------------- helpers

  private async requireWeek(db: DbClient, contentId: string, weekId: string): Promise<void> {
    const week = await db.courseWeek.findFirst({ where: { id: weekId, contentId }, select: { id: true } });
    if (!week) throw new NotFoundException('Week not found.');
  }

  private toValues(row: CourseAssignment): AssignmentValues {
    return {
      title: row.title,
      brief: row.brief,
      includes: row.includes,
      successEvidence: row.successEvidence,
      expectedMinutes: row.expectedMinutes,
      allowedFileTypes: row.allowedFileTypes as FileType[],
      rubric: row.rubric as unknown as Rubric,
      rubricVisible: row.rubricVisible,
    };
  }

  private assignmentView(row: CourseAssignment) {
    return {
      id: row.id,
      weekId: row.weekId,
      title: row.title,
      brief: row.brief,
      includes: row.includes,
      successEvidence: row.successEvidence,
      expectedMinutes: row.expectedMinutes,
      allowedFileTypes: row.allowedFileTypes,
      rubric: row.rubric,
      rubricVisible: row.rubricVisible,
      revision: row.revision,
    };
  }

  private sessionView(row: CourseClassSession) {
    const local = localParts(row.startsAt, branding.timezone);
    return {
      id: row.id,
      weekId: row.weekId,
      /** Chicago date and time, as the instructor entered them. */
      date: local.date,
      time: local.time,
      timezone: branding.timezone,
      /** The exact moment (UTC), for showing the student's own local time. */
      startsAt: row.startsAt,
      durationMinutes: row.durationMinutes,
      joinUrl: row.joinUrl,
      notes: row.notes,
      revision: row.revision,
    };
  }
}
EOF

# ============================================================================
cat > src/course-content/course-planning.controller.ts <<'EOF'
/**
 * course-planning.controller.ts
 * ---------------------------------------------------------------------------
 * A week's assignment and live class (same people and rules as editing the course):
 *
 *   GET    /api/v1/course-content/:contentId/weeks/:weekId/planning        the week's assignment + live class
 *   PUT    /api/v1/course-content/:contentId/weeks/:weekId/assignment      create / update the assignment (send only the fields to set)
 *   DELETE /api/v1/course-content/:contentId/weeks/:weekId/assignment      remove it
 *   PUT    /api/v1/course-content/:contentId/weeks/:weekId/class-session   set the live class (Chicago date and time)
 *   DELETE /api/v1/course-content/:contentId/weeks/:weekId/class-session   remove it
 *
 * Every change answers with the new draftRevision, like the other draft edits.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CoursePlanningService } from './course-planning.service';
import { SaveAssignmentDto } from './dto/assignment.dto';
import { SaveClassSessionDto } from './dto/class-session.dto';

const uuid = () => new ParseUUIDPipe();

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('course-content')
export class CoursePlanningController {
  constructor(private readonly planning: CoursePlanningService) {}

  @Get(':contentId/weeks/:weekId/planning')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
  ) {
    return this.planning.getPlanning(user, contentId, weekId);
  }

  @Put(':contentId/weeks/:weekId/assignment')
  saveAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: SaveAssignmentDto,
  ) {
    return this.planning.saveAssignment(user, contentId, weekId, dto);
  }

  @Delete(':contentId/weeks/:weekId/assignment')
  @HttpCode(200)
  removeAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Req() req: Request,
  ) {
    return this.planning.removeAssignment(user, contentId, weekId, getRequestContext(req));
  }

  @Put(':contentId/weeks/:weekId/class-session')
  saveClassSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: SaveClassSessionDto,
  ) {
    return this.planning.saveClassSession(user, contentId, weekId, dto);
  }

  @Delete(':contentId/weeks/:weekId/class-session')
  @HttpCode(200)
  removeClassSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
  ) {
    return this.planning.removeClassSession(user, contentId, weekId);
  }
}
EOF

# ============================================================================
cat > src/learning/assignment-rules.ts <<'EOF'
/**
 * assignment-rules.ts
 * ---------------------------------------------------------------------------
 * The deadline rules for assignments, as pure functions (no database).
 *
 *   DUE       3 days after the live class, at 5:00 PM Chicago time
 *   LATE      work is still accepted for 7 more days and is labelled "Late"
 *   CLOSED    after that, nothing can be submitted ("Ask your instructor")
 *
 * "3 days after class" counts CALENDAR days in Chicago, and "5:00 PM" is Chicago wall-clock
 * time, so the deadline stays at 5 PM in winter and in summer. When a week has no live
 * class date yet, there is no deadline and the assignment is simply open.
 */
import { addDaysToLocalDate, localParts, zonedDateTimeToUtc } from '../common/utils/zoned-time';
import { branding } from '../config/branding.config';

export const DUE_DAYS_AFTER_CLASS = 3;
export const DUE_TIME = '17:00';
export const LATE_WINDOW_DAYS = 7;

export type SubmissionPhase = 'NO_DUE_DATE' | 'OPEN' | 'LATE' | 'CLOSED';

export interface Schedule {
  timezone: string;
  classStartsAt: Date | null;
  /** The moment the assignment is due (null when the week has no class date yet). */
  dueAt: Date | null;
  /** The moment late work stops being accepted. */
  closesAt: Date | null;
}

export function scheduleFor(classStartsAt: Date | null, zone: string = branding.timezone): Schedule {
  if (!classStartsAt) return { timezone: zone, classStartsAt: null, dueAt: null, closesAt: null };

  const classDate = localParts(classStartsAt, zone).date;
  const dueDate = addDaysToLocalDate(classDate, DUE_DAYS_AFTER_CLASS);
  const closeDate = addDaysToLocalDate(dueDate, LATE_WINDOW_DAYS);

  return {
    timezone: zone,
    classStartsAt,
    dueAt: zonedDateTimeToUtc(dueDate, DUE_TIME, zone),
    closesAt: zonedDateTimeToUtc(closeDate, DUE_TIME, zone),
  };
}

/** Where the assignment stands at a given moment. */
export function phaseAt(schedule: Schedule, now: Date): SubmissionPhase {
  if (!schedule.dueAt || !schedule.closesAt) return 'NO_DUE_DATE';
  if (now.getTime() <= schedule.dueAt.getTime()) return 'OPEN';
  if (now.getTime() <= schedule.closesAt.getTime()) return 'LATE';
  return 'CLOSED';
}

export const LATE_MESSAGE =
  "This assignment is past its due date. You can still submit - it will be marked 'Late' so your instructor knows.";
export const CLOSED_MESSAGE = 'This assignment is closed. Ask your instructor.';
EOF

# ============================================================================
cat > src/learning/assignments.service.ts <<'EOF'
/**
 * assignments.service.ts  (the student's side)
 * ---------------------------------------------------------------------------
 * The student's assignments: the list ("All assignments / To do / Submitted / Feedback")
 * and one assignment's detail.
 *
 *  - Students only see the assignments of the LIVE PUBLISHED version of their own cohort's course.
 *  - An assignment in a LOCKED week shows only its title and why it is locked - never its brief.
 *  - The deadline is worked out from the week's live class (see assignment-rules.ts). The
 *    answer carries exact instants plus the timezone, so the screen can show both
 *    "Fri, Oct 9 at 5:00 PM Central" and the student's own local time.
 *  - The rubric is sent only when the instructor made it visible to students.
 *
 * Submitting work, receipts and feedback arrive in the next parts of this batch; until then
 * every unlocked assignment is "Not submitted".
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { formatCalendarDate } from '../catalog/catalog.util';
import { PrismaService } from '../prisma/prisma.service';
import { CLOSED_MESSAGE, LATE_MESSAGE, phaseAt, scheduleFor } from './assignment-rules';
import { LearningAccessService, LearningContext } from './learning-access.service';
import { evaluateWeeks, WeekProgress } from './learning-rules';
import { cohortNotStartedMessage, NOT_OPEN_MESSAGE, NOT_READY_MESSAGE } from './learning.constants';
import { PublishedCourseService } from './published-course.service';
import type { Snapshot, SnapshotAssignment, SnapshotWeek } from '../course-content/snapshot';

export type AssignmentTab = 'all' | 'todo' | 'submitted' | 'feedback';
export const ASSIGNMENT_TABS: readonly AssignmentTab[] = ['all', 'todo', 'submitted', 'feedback'];

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly published: PublishedCourseService,
  ) {}

  // -------------------------------------------------------------------- list

  async list(user: AuthenticatedUser, tab: AssignmentTab) {
    if (!ASSIGNMENT_TABS.includes(tab)) throw new BadRequestException(`tab must be one of: ${ASSIGNMENT_TABS.join(', ')}.`);

    const context = await this.requireReady(user);
    const { snapshot, weeks } = await this.load(context);
    const now = new Date();

    const items = snapshot.weeks.flatMap((week, index) => {
      if (!week.assignment) return [];
      return [this.summarize(week, week.assignment, weeks[index], context, now)];
    });

    // Nothing is submitted or reviewed yet, so only "all" and "to do" can have rows.
    const visible = tab === 'all' ? items : tab === 'todo' ? items.filter((item) => item.status === 'NOT_SUBMITTED') : [];
    return { tab, assignments: visible };
  }

  // ------------------------------------------------------------------ detail

  async detail(user: AuthenticatedUser, assignmentId: string) {
    const context = await this.requireReady(user);
    const { snapshot, weeks } = await this.load(context);

    const index = snapshot.weeks.findIndex((week) => week.assignment?.id === assignmentId);
    const week = snapshot.weeks[index];
    const assignment = week?.assignment;
    if (!week || !assignment) throw new NotFoundException('Assignment not found.');

    const progress = weeks[index];
    const now = new Date();
    const summary = this.summarize(week, assignment, progress, context, now);

    // A locked week: the title and the reason only.
    if (!progress.open) {
      return {
        locked: true as const,
        assignment: { id: assignment.id, title: assignment.title },
        week: summary.week,
        lockedReason: progress.lockedReason,
      };
    }

    return {
      locked: false as const,
      assignment: {
        id: assignment.id,
        title: assignment.title,
        brief: assignment.brief,
        includes: assignment.includes,
        successEvidence: assignment.successEvidence,
        expectedMinutes: assignment.expectedMinutes,
        allowedFileTypes: assignment.allowedFileTypes,
        // Only when the instructor chose to show it.
        rubric: assignment.rubricVisible ? assignment.rubric : null,
      },
      week: summary.week,
      status: summary.status,
      schedule: summary.schedule,
      canSubmit: summary.canSubmit,
      notice: summary.phase === 'LATE' ? LATE_MESSAGE : summary.phase === 'CLOSED' ? CLOSED_MESSAGE : null,
      readOnly: context.readOnly,
    };
  }

  // ----------------------------------------------------------------- helpers

  private summarize(week: SnapshotWeek, assignment: SnapshotAssignment, progress: WeekProgress, context: LearningContext, now: Date) {
    const schedule = scheduleFor(week.classSession ? new Date(week.classSession.startsAt) : null);
    const phase = phaseAt(schedule, now);
    const open = progress.open;

    return {
      id: assignment.id,
      title: assignment.title,
      expectedMinutes: assignment.expectedMinutes,
      week: { id: week.id, position: progress.position, title: week.title },
      status: open ? ('NOT_SUBMITTED' as const) : ('LOCKED' as const),
      phase,
      schedule: {
        timezone: schedule.timezone,
        classStartsAt: schedule.classStartsAt,
        dueAt: schedule.dueAt,
        closesAt: schedule.closesAt,
        phase,
      },
      canSubmit: open && !context.readOnly && phase !== 'CLOSED',
      cohortStartsOn: formatCalendarDate(context.cohort.startsOn),
    };
  }

  private async load(context: LearningContext): Promise<{ snapshot: Snapshot; weeks: WeekProgress[] }> {
    const snapshot = await this.published.get(context.contentId, context.version);
    const [done, opened] = await Promise.all([
      this.prisma.lessonProgress.findMany({
        where: { enrollmentId: context.enrollmentId, completedAt: { not: null } },
        select: { lessonId: true },
      }),
      this.prisma.weekUnlock.findMany({ where: { enrollmentId: context.enrollmentId }, select: { weekId: true } }),
    ]);
    const weeks = evaluateWeeks(snapshot, {
      completed: new Set(done.map((row) => row.lessonId)),
      unlocked: new Set(opened.map((row) => row.weekId)),
      allOpen: context.readOnly,
    });
    return { snapshot, weeks };
  }

  private async requireReady(user: AuthenticatedUser): Promise<LearningContext> {
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
}
EOF

cat > src/learning/assignments.controller.ts <<'EOF'
/**
 * assignments.controller.ts
 * ---------------------------------------------------------------------------
 * The student's assignments (students only).
 *
 *   GET /api/v1/learn/assignments?tab=all|todo|submitted|feedback     the list
 *   GET /api/v1/learn/assignments/:assignmentId                       one assignment (title and reason only if its week is locked)
 */
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AssignmentTab, AssignmentsService } from './assignments.service';

@Roles(Role.STUDENT)
@Controller('learn/assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('tab') tab: string = 'all') {
    return this.assignments.list(user, tab as AssignmentTab);
  }

  @Get(':assignmentId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string) {
    return this.assignments.detail(user, assignmentId);
  }
}
EOF

echo "New 4A files created. Now replace snapshot.ts, snapshot-diff.ts, write-snapshot.ts, course-content.module.ts, learning.module.ts and prisma/schema.prisma with the versions below."