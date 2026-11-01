#!/usr/bin/env bash
# Batch 2B-1 - draft changes, publish, version history, compare. Run from the repo root.
set -euo pipefail
cd backend
mkdir -p prisma/migrations/20261030000000_course_versions src/course-content/dto

# ============================================================================
cat > prisma/migrations/20261030000000_course_versions/migration.sql <<'EOF'
-- Batch 2B-1: publishing and version history for course content.
--
--   course_versions   every PUBLISHED version of a course copy: a frozen snapshot of
--                     all its weeks, lessons and blocks, with who published it, their
--                     role, when, and a list of what changed. Versions are never
--                     edited or deleted ("nothing is ever overwritten").
--   course_contents   gets three columns that say which version is LIVE.
--   edited_by_id      on weeks, lessons and blocks: who last changed each item. A
--                     database trigger fills it in, so no application code can forget.
--
-- Written by hand (triggers and CHECK rules); names follow Prisma's conventions.

CREATE TYPE "VersionSource" AS ENUM ('PUBLISH', 'RESTORE');

-- ---------------------------------------------------------------------------
-- course_versions
-- ---------------------------------------------------------------------------
CREATE TABLE "course_versions" (
  "id"                   UUID           NOT NULL DEFAULT gen_random_uuid(),
  "content_id"           UUID           NOT NULL,
  "number"               INTEGER        NOT NULL,
  "source"               "VersionSource" NOT NULL,
  "summary"              VARCHAR(500)   NOT NULL,
  "snapshot"             JSONB          NOT NULL,
  "changes"              JSONB          NOT NULL,
  "week_count"           INTEGER        NOT NULL,
  "lesson_count"         INTEGER        NOT NULL,
  "block_count"          INTEGER        NOT NULL,
  "published_by_id"      UUID           NOT NULL,
  "published_by_role"    "Role"         NOT NULL,
  "restored_from_number" INTEGER,
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "course_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "course_versions_number_check"   CHECK ("number" >= 1),
  CONSTRAINT "course_versions_counts_check"   CHECK ("week_count" >= 0 AND "lesson_count" >= 0 AND "block_count" >= 0),
  CONSTRAINT "course_versions_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object'),
  CONSTRAINT "course_versions_changes_check"  CHECK (jsonb_typeof("changes") = 'array'),
  CONSTRAINT "course_versions_restore_check"  CHECK (("source" = 'RESTORE') = ("restored_from_number" IS NOT NULL))
);

CREATE UNIQUE INDEX "course_versions_content_id_number_key" ON "course_versions"("content_id", "number");

ALTER TABLE "course_versions"
  ADD CONSTRAINT "course_versions_content_id_fkey"
    FOREIGN KEY ("content_id") REFERENCES "course_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- HAND-WRITTEN rule: a saved version can never be changed or removed.
CREATE FUNCTION "course_versions_refuse_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'course_versions is append-only: a saved version cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "course_versions_immutable"
  BEFORE UPDATE OR DELETE ON "course_versions"
  FOR EACH ROW EXECUTE FUNCTION "course_versions_refuse_change"();

-- ---------------------------------------------------------------------------
-- course_contents: which version is live
--   published_version         the live version number (empty = nothing published yet)
--   published_at              when it went live
--   published_draft_revision  the draft revision at that moment; if the draft revision
--                             is different now, there may be unpublished changes
-- ---------------------------------------------------------------------------
ALTER TABLE "course_contents"
  ADD COLUMN "published_version"        INTEGER,
  ADD COLUMN "published_at"             TIMESTAMPTZ(3),
  ADD COLUMN "published_draft_revision" INTEGER;

ALTER TABLE "course_contents"
  ADD CONSTRAINT "course_contents_published_check"
    CHECK (("published_version" IS NULL) = ("published_at" IS NULL)
       AND ("published_version" IS NULL) = ("published_draft_revision" IS NULL));

-- ---------------------------------------------------------------------------
-- Who last changed each item. The application announces the signed-in person at
-- the start of every edit ("app.user_id"); this trigger stamps it on each
-- inserted or updated row. Rows written outside an edit (for example a copy made
-- from a template) keep an empty editor.
-- ---------------------------------------------------------------------------
ALTER TABLE "course_weeks"   ADD COLUMN "edited_by_id" UUID;
ALTER TABLE "course_lessons" ADD COLUMN "edited_by_id" UUID;
ALTER TABLE "lesson_blocks"  ADD COLUMN "edited_by_id" UUID;

CREATE FUNCTION "course_content_stamp_editor"() RETURNS trigger AS $$
DECLARE
  editor text := current_setting('app.user_id', true);
BEGIN
  IF editor IS NOT NULL AND editor <> '' THEN
    NEW."edited_by_id" := editor::uuid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "course_weeks_stamp_editor"
  BEFORE INSERT OR UPDATE ON "course_weeks"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
CREATE TRIGGER "course_lessons_stamp_editor"
  BEFORE INSERT OR UPDATE ON "course_lessons"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
CREATE TRIGGER "lesson_blocks_stamp_editor"
  BEFORE INSERT OR UPDATE ON "lesson_blocks"
  FOR EACH ROW EXECUTE FUNCTION "course_content_stamp_editor"();
EOF

# ============================================================================
cat > src/course-content/snapshot.ts <<'EOF'
/**
 * snapshot.ts
 * ---------------------------------------------------------------------------
 * A SNAPSHOT is a frozen picture of a whole course copy: every week, every
 * lesson in it and every block in each lesson, in order. A published version IS
 * a snapshot; the draft is turned into one whenever we need to compare it.
 *
 * Positions are implied by the order of the lists, so a snapshot never has gaps
 * or duplicate positions. Every item keeps its permanent id, which is how two
 * snapshots are compared ("this is the same lesson, with a new title").
 */
import { InternalServerErrorException } from '@nestjs/common';
import type { BlockType, Prisma } from '@prisma/client';

import type { DbClient } from '../common/types/db-client';

export interface SnapshotBlock {
  id: string;
  type: BlockType;
  instructorOnly: boolean;
  data: Prisma.JsonObject;
  /** The template item this one was copied from (empty if it was created here). */
  originId: string | null;
}

export interface SnapshotLesson {
  id: string;
  title: string;
  summary: string | null;
  estimatedMinutes: number | null;
  originId: string | null;
  blocks: SnapshotBlock[];
}

export interface SnapshotWeek {
  id: string;
  title: string;
  summary: string | null;
  originId: string | null;
  lessons: SnapshotLesson[];
}

export interface Snapshot {
  /** The layout of this snapshot, so a future change can still read old versions. */
  format: 1;
  weeks: SnapshotWeek[];
}

export const EMPTY_SNAPSHOT: Snapshot = { format: 1, weeks: [] };

/** Who last changed an item and when (from the draft rows). */
export interface ItemMeta {
  editedById: string | null;
  updatedAt: Date;
}

export interface DraftLoad {
  snapshot: Snapshot;
  /** item id -> who / when. */
  meta: Map<string, ItemMeta>;
}

/** Reads the current DRAFT of a course copy and turns it into a snapshot (3 queries). */
export async function loadDraft(db: DbClient, contentId: string): Promise<DraftLoad> {
  const order = [{ position: 'asc' as const }, { id: 'asc' as const }];
  const weeks = await db.courseWeek.findMany({ where: { contentId }, orderBy: order });
  const lessons = await db.courseLesson.findMany({ where: { contentId }, orderBy: order });
  const blocks = await db.lessonBlock.findMany({ where: { contentId }, orderBy: order });

  const meta = new Map<string, ItemMeta>();
  for (const row of [...weeks, ...lessons, ...blocks]) {
    meta.set(row.id, { editedById: row.editedById, updatedAt: row.updatedAt });
  }

  const blocksByLesson = new Map<string, SnapshotBlock[]>();
  for (const block of blocks) {
    const list = blocksByLesson.get(block.lessonId) ?? [];
    list.push({
      id: block.id,
      type: block.type,
      instructorOnly: block.instructorOnly,
      data: block.data as Prisma.JsonObject,
      originId: block.originId,
    });
    blocksByLesson.set(block.lessonId, list);
  }

  const lessonsByWeek = new Map<string, SnapshotLesson[]>();
  for (const lesson of lessons) {
    const list = lessonsByWeek.get(lesson.weekId) ?? [];
    list.push({
      id: lesson.id,
      title: lesson.title,
      summary: lesson.summary,
      estimatedMinutes: lesson.estimatedMinutes,
      originId: lesson.originId,
      blocks: blocksByLesson.get(lesson.id) ?? [],
    });
    lessonsByWeek.set(lesson.weekId, list);
  }

  return {
    snapshot: {
      format: 1,
      weeks: weeks.map((week) => ({
        id: week.id,
        title: week.title,
        summary: week.summary,
        originId: week.originId,
        lessons: lessonsByWeek.get(week.id) ?? [],
      })),
    },
    meta,
  };
}

/** Reads a stored snapshot back, refusing anything that is not in the layout we expect. */
export function parseSnapshot(value: Prisma.JsonValue): Snapshot {
  const candidate = value as { format?: unknown; weeks?: unknown } | null;
  if (!candidate || typeof candidate !== 'object' || candidate.format !== 1 || !Array.isArray(candidate.weeks)) {
    throw new InternalServerErrorException('A stored course version could not be read.');
  }
  return value as unknown as Snapshot;
}

export interface SnapshotCounts {
  weeks: number;
  lessons: number;
  blocks: number;
}

export function countSnapshot(snapshot: Snapshot): SnapshotCounts {
  let lessons = 0;
  let blocks = 0;
  for (const week of snapshot.weeks) {
    lessons += week.lessons.length;
    for (const lesson of week.lessons) blocks += lesson.blocks.length;
  }
  return { weeks: snapshot.weeks.length, lessons, blocks };
}
EOF

# ============================================================================
cat > src/course-content/snapshot-diff.ts <<'EOF'
/**
 * snapshot-diff.ts
 * ---------------------------------------------------------------------------
 * Compares two snapshots of a course copy and says exactly what changed. Pure
 * functions (no database), so they can be tested on their own.
 *
 * How items are matched: by their permanent id. For every week, lesson and block:
 *   ADDED    it exists only in the newer snapshot
 *   REMOVED  it exists only in the older snapshot
 *   EDITED   it exists in both and something inside it changed
 *   MOVED    it exists in both, only its place changed
 * An item that was both edited and moved is reported once, as EDITED, with a
 * "position" entry among its changed fields.
 *
 * To keep the list readable, the CONTENTS of an added or removed week or lesson
 * are not listed one by one: the week / lesson is reported once, with a count of
 * what is inside it.
 *
 * Moves are found with a "longest unchanged order" rule: when one lesson jumps
 * from first to fourth, only that lesson is reported as moved, not the three it
 * passed.
 */
import type { BlockType } from '@prisma/client';

import type { Snapshot, SnapshotBlock, SnapshotLesson, SnapshotWeek } from './snapshot';

export type ItemKind = 'WEEK' | 'LESSON' | 'BLOCK';
export type ChangeType = 'ADDED' | 'REMOVED' | 'EDITED' | 'MOVED';

export interface LineDiff {
  type: 'same' | 'add' | 'remove';
  text: string;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
  /** For text fields: the line-by-line difference. */
  lines?: LineDiff[];
}

export interface Change {
  kind: ItemKind;
  type: ChangeType;
  id: string;
  /** A short human label: the week or lesson title, or what the block is. */
  title: string;
  where: { week: string | null; lesson: string | null };
  fields: FieldChange[];
}

// ------------------------------------------------------------------ small helpers

/** JSON text with sorted keys, so two equal objects always compare equal. */
function stable(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const source = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sort(source[key])]));
    }
    return v ?? null;
  };
  return JSON.stringify(sort(value));
}

const MAX_DIFF_LINES = 1_500;

/** Line-by-line difference between two texts (unchanged lines are kept, so the screen can show context). */
export function diffLines(before: string, after: string): LineDiff[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const asLines = (type: LineDiff['type'], lines: string[]): LineDiff[] => lines.map((text) => ({ type, text }));

  // Very long texts: do not spend time on a fine comparison.
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return [...asLines('remove', a), ...asLines('add', b)];

  // Skip the lines that are the same at the start and the end.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const n = middleA.length;
  const m = middleB.length;

  // Longest-common-subsequence table for the part in the middle.
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = middleA[i] === middleB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const middle: LineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (middleA[i] === middleB[j]) {
      middle.push({ type: 'same', text: middleA[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      middle.push({ type: 'remove', text: middleA[i] });
      i += 1;
    } else {
      middle.push({ type: 'add', text: middleB[j] });
      j += 1;
    }
  }
  while (i < n) middle.push({ type: 'remove', text: middleA[i++] });
  while (j < m) middle.push({ type: 'add', text: middleB[j++] });

  return [...asLines('same', a.slice(0, start)), ...middle, ...asLines('same', a.slice(endA))];
}

/**
 * Which of these ids were MOVED? Both lists hold the same ids in a different
 * order; the ids that keep their relative order (the longest such run) are not
 * moved, all the others are.
 */
export function movedIds(beforeOrder: readonly string[], afterOrder: readonly string[]): Set<string> {
  const placeInAfter = new Map(afterOrder.map((id, index) => [id, index]));
  const sequence = beforeOrder.map((id) => placeInAfter.get(id) as number);

  const length: number[] = sequence.map(() => 1);
  const previous: number[] = sequence.map(() => -1);
  let best = -1;
  for (let i = 0; i < sequence.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (sequence[j] < sequence[i] && length[j] + 1 > length[i]) {
        length[i] = length[j] + 1;
        previous[i] = j;
      }
    }
    if (best === -1 || length[i] > length[best]) best = i;
  }

  const stableIndexes = new Set<number>();
  for (let k = best; k !== -1; k = previous[k]) stableIndexes.add(k);
  return new Set(beforeOrder.filter((_, index) => !stableIndexes.has(index)));
}

/** A short label for a block, taken from its contents. */
export function blockLabel(type: BlockType, data: Record<string, unknown>): string {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const clip = (value: string): string => (value.length > 60 ? `${value.slice(0, 57)}...` : value);

  switch (type) {
    case 'TEXT':
      return text(data.body) ? clip(text(data.body).split('\n')[0]) : 'Text';
    case 'VIDEO':
      return 'Video';
    case 'ACTIVITY':
      return clip(text(data.title)) || 'Activity';
    case 'STEPS':
      return clip(text(data.title)) || 'Steps';
    case 'CALLOUT':
      return clip(text(data.title)) || 'Callout';
    case 'RESOURCE':
      return clip(text(data.title)) || 'Resource';
    default:
      return 'Block';
  }
}

/** The fields (from `names`) whose value differs, with a line diff for text. */
function differences(names: readonly string[], before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const result: FieldChange[] = [];
  for (const field of names) {
    const was = before[field] ?? null;
    const now = after[field] ?? null;
    if (stable(was) === stable(now)) continue;

    const change: FieldChange = { field, before: was, after: now };
    if ((typeof was === 'string' || was === null) && (typeof now === 'string' || now === null)) {
      change.lines = diffLines(was ?? '', now ?? '');
    }
    result.push(change);
  }
  return result;
}

const POSITION_FIELDS = new Set(['position', 'week']);

/** EDITED when real content changed; MOVED when only the place (or the week) did. */
function typeOf(fields: FieldChange[]): ChangeType {
  return fields.some((change) => !POSITION_FIELDS.has(change.field)) ? 'EDITED' : 'MOVED';
}

// ------------------------------------------------------------------ the comparison

interface LessonEntry {
  lesson: SnapshotLesson;
  weekId: string;
  weekTitle: string;
  index: number;
}

interface BlockEntry {
  block: SnapshotBlock;
  lessonId: string;
  lessonTitle: string;
  weekTitle: string;
  index: number;
}

interface Index {
  weeks: Map<string, { week: SnapshotWeek; index: number }>;
  lessons: Map<string, LessonEntry>;
  blocks: Map<string, BlockEntry>;
}

function indexOf(snapshot: Snapshot): Index {
  const weeks: Index['weeks'] = new Map();
  const lessons: Index['lessons'] = new Map();
  const blocks: Index['blocks'] = new Map();

  snapshot.weeks.forEach((week, weekIndex) => {
    weeks.set(week.id, { week, index: weekIndex });
    week.lessons.forEach((lesson, lessonIndex) => {
      lessons.set(lesson.id, { lesson, weekId: week.id, weekTitle: week.title, index: lessonIndex });
      lesson.blocks.forEach((block, blockIndex) => {
        blocks.set(block.id, { block, lessonId: lesson.id, lessonTitle: lesson.title, weekTitle: week.title, index: blockIndex });
      });
    });
  });
  return { weeks, lessons, blocks };
}

const countLesson = (lesson: SnapshotLesson) => ({ blocks: lesson.blocks.length });
const countWeek = (week: SnapshotWeek) => ({
  lessons: week.lessons.length,
  blocks: week.lessons.reduce((total, lesson) => total + lesson.blocks.length, 0),
});

/** Ids that exist in both lists, in the order of `source`. */
const common = (source: readonly string[], other: ReadonlySet<string>): string[] => source.filter((id) => other.has(id));

export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  const was = indexOf(before);
  const now = indexOf(after);

  // ------------------------------------------------------------ weeks
  for (const [id, { week }] of now.weeks) {
    if (!was.weeks.has(id)) {
      changes.push({ kind: 'WEEK', type: 'ADDED', id, title: week.title, where: { week: null, lesson: null }, fields: [{ field: 'contents', before: null, after: countWeek(week) }] });
    }
  }
  for (const [id, { week }] of was.weeks) {
    if (!now.weeks.has(id)) {
      changes.push({ kind: 'WEEK', type: 'REMOVED', id, title: week.title, where: { week: null, lesson: null }, fields: [{ field: 'contents', before: countWeek(week), after: null }] });
    }
  }
  const weekMoves = movedIds(
    common(before.weeks.map((w) => w.id), new Set(now.weeks.keys())),
    common(after.weeks.map((w) => w.id), new Set(was.weeks.keys())),
  );
  for (const [id, old] of was.weeks) {
    const current = now.weeks.get(id);
    if (!current) continue;
    const fields = differences(['title', 'summary'], old.week as unknown as Record<string, unknown>, current.week as unknown as Record<string, unknown>);
    if (weekMoves.has(id)) fields.push({ field: 'position', before: old.index + 1, after: current.index + 1 });
    if (fields.length > 0) {
      changes.push({ kind: 'WEEK', type: typeOf(fields), id, title: current.week.title, where: { week: null, lesson: null }, fields });
    }
  }

  // ---------------------------------------------------------- lessons
  for (const [id, entry] of now.lessons) {
    // A lesson inside a week that is itself new is covered by that week's entry.
    if (!was.lessons.has(id) && was.weeks.has(entry.weekId)) {
      changes.push({ kind: 'LESSON', type: 'ADDED', id, title: entry.lesson.title, where: { week: entry.weekTitle, lesson: null }, fields: [{ field: 'contents', before: null, after: countLesson(entry.lesson) }] });
    }
  }
  for (const [id, entry] of was.lessons) {
    if (!now.lessons.has(id) && now.weeks.has(entry.weekId)) {
      changes.push({ kind: 'LESSON', type: 'REMOVED', id, title: entry.lesson.title, where: { week: entry.weekTitle, lesson: null }, fields: [{ field: 'contents', before: countLesson(entry.lesson), after: null }] });
    }
  }

  // Lessons that stayed in the same week: which ones changed their place?
  const lessonMoves = new Set<string>();
  for (const [weekId, { week: oldWeek }] of was.weeks) {
    const newWeek = now.weeks.get(weekId);
    if (!newWeek) continue;
    const keptHere = (lesson: SnapshotLesson, other: Index) => other.lessons.get(lesson.id)?.weekId === weekId;
    const beforeOrder = oldWeek.lessons.filter((lesson) => keptHere(lesson, now)).map((lesson) => lesson.id);
    const afterOrder = newWeek.week.lessons.filter((lesson) => keptHere(lesson, was)).map((lesson) => lesson.id);
    for (const id of movedIds(beforeOrder, afterOrder)) lessonMoves.add(id);
  }

  for (const [id, old] of was.lessons) {
    const current = now.lessons.get(id);
    if (!current) continue;
    const fields = differences(['title', 'summary', 'estimatedMinutes'], old.lesson as unknown as Record<string, unknown>, current.lesson as unknown as Record<string, unknown>);
    if (old.weekId !== current.weekId) fields.push({ field: 'week', before: old.weekTitle, after: current.weekTitle });
    else if (lessonMoves.has(id)) fields.push({ field: 'position', before: old.index + 1, after: current.index + 1 });
    if (fields.length > 0) {
      changes.push({ kind: 'LESSON', type: typeOf(fields), id, title: current.lesson.title, where: { week: current.weekTitle, lesson: null }, fields });
    }
  }

  // ----------------------------------------------------------- blocks
  for (const [id, entry] of now.blocks) {
    if (!was.blocks.has(id) && was.lessons.has(entry.lessonId)) {
      changes.push({ kind: 'BLOCK', type: 'ADDED', id, title: blockLabel(entry.block.type, entry.block.data), where: { week: entry.weekTitle, lesson: entry.lessonTitle }, fields: [{ field: 'type', before: null, after: entry.block.type }] });
    }
  }
  for (const [id, entry] of was.blocks) {
    if (!now.blocks.has(id) && now.lessons.has(entry.lessonId)) {
      changes.push({ kind: 'BLOCK', type: 'REMOVED', id, title: blockLabel(entry.block.type, entry.block.data), where: { week: entry.weekTitle, lesson: entry.lessonTitle }, fields: [{ field: 'type', before: entry.block.type, after: null }] });
    }
  }

  const blockMoves = new Set<string>();
  for (const [lessonId, { lesson: oldLesson }] of was.lessons) {
    const newLesson = now.lessons.get(lessonId);
    if (!newLesson) continue;
    const beforeOrder = common(oldLesson.blocks.map((b) => b.id), new Set(newLesson.lesson.blocks.map((b) => b.id)));
    const afterOrder = common(newLesson.lesson.blocks.map((b) => b.id), new Set(oldLesson.blocks.map((b) => b.id)));
    for (const id of movedIds(beforeOrder, afterOrder)) blockMoves.add(id);
  }

  for (const [id, old] of was.blocks) {
    const current = now.blocks.get(id);
    if (!current) continue;

    const dataKeys = [...new Set([...Object.keys(old.block.data), ...Object.keys(current.block.data)])].sort();
    const fields = [
      ...differences(['instructorOnly'], old.block as unknown as Record<string, unknown>, current.block as unknown as Record<string, unknown>),
      ...differences(dataKeys, old.block.data, current.block.data),
    ];
    if (blockMoves.has(id)) fields.push({ field: 'position', before: old.index + 1, after: current.index + 1 });
    if (fields.length > 0) {
      changes.push({ kind: 'BLOCK', type: typeOf(fields), id, title: blockLabel(current.block.type, current.block.data), where: { week: current.weekTitle, lesson: current.lessonTitle }, fields });
    }
  }

  return changes;
}

// ------------------------------------------------------------------ summaries

const NOUN: Record<ItemKind, string> = { WEEK: 'week', LESSON: 'lesson', BLOCK: 'block' };
const VERB: Record<ChangeType, string> = { EDITED: 'edited', ADDED: 'added', REMOVED: 'removed', MOVED: 'moved' };

/** "2 lessons edited, 1 block added" - a plain description of what a list of changes contains. */
export function summarizeChanges(changes: readonly Change[]): string {
  const parts: string[] = [];
  for (const kind of ['WEEK', 'LESSON', 'BLOCK'] as const) {
    for (const type of ['EDITED', 'ADDED', 'REMOVED', 'MOVED'] as const) {
      const total = changes.filter((change) => change.kind === kind && change.type === type).length;
      if (total > 0) parts.push(`${total} ${NOUN[kind]}${total === 1 ? '' : 's'} ${VERB[type]}`);
    }
  }
  if (parts.length === 0) return 'No changes';
  const text = parts.join(', ');
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 500);
}

export interface ChangeCounts {
  total: number;
  weeks: number;
  lessons: number;
  blocks: number;
}

export function countChanges(changes: readonly Change[]): ChangeCounts {
  return {
    total: changes.length,
    weeks: changes.filter((change) => change.kind === 'WEEK').length,
    lessons: changes.filter((change) => change.kind === 'LESSON').length,
    blocks: changes.filter((change) => change.kind === 'BLOCK').length,
  };
}

/** A change without the (possibly large) before / after values: just which fields changed. */
export function toBrief(change: Change) {
  return {
    kind: change.kind,
    type: change.type,
    id: change.id,
    title: change.title,
    where: change.where,
    changedFields: change.fields.map((field) => field.field),
  };
}
EOF

# ============================================================================
cat > src/course-content/dto/publish.dto.ts <<'EOF'
/**
 * publish.dto.ts - what the screen sends when the person confirms "Publish".
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Trims the note; an empty box counts as "no note". */
const textOrUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class PublishDto {
  /** A short note about this version. Leave out to get an automatic summary such as "2 lessons edited". */
  @IsOptional()
  @Transform(textOrUndefined)
  @IsString()
  @MaxLength(300)
  summary?: string;

  /**
   * The draft revision the person reviewed in the confirmation. If someone edited the
   * draft since, publishing is refused so nobody publishes changes they never saw.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedDraftRevision?: number;
}
EOF

cat > src/course-content/dto/compare.query.ts <<'EOF'
/**
 * compare.query.ts
 * ---------------------------------------------------------------------------
 *   ?from=live&to=draft          (the default)  what is waiting to be published
 *   ?from=6&to=7                 version 6 against version 7
 *   ?from=6&to=draft             version 6 against the current draft
 * Each side is "live", "draft" or a version number.
 */
import { IsOptional, Matches } from 'class-validator';

const REFERENCE = /^(live|draft|[1-9][0-9]{0,8})$/;
const MESSAGE = 'Use "live", "draft" or a version number.';

export class CompareQuery {
  @IsOptional()
  @Matches(REFERENCE, { message: MESSAGE })
  from: string = 'live';

  @IsOptional()
  @Matches(REFERENCE, { message: MESSAGE })
  to: string = 'draft';
}
EOF

# ============================================================================
cat > src/course-content/content-editor.service.ts <<'EOF'
/**
 * content-editor.service.ts
 * ---------------------------------------------------------------------------
 * The gatekeeper for course content. Every read and every edit goes through it.
 *
 *   open()  checks that the content exists (404 otherwise) and that THIS person
 *           may open it (403 otherwise).
 *   run()   does something as the ONLY person working on that course copy:
 *             1. check the person may work on it;
 *             2. start a transaction and LOCK the copy, so two actions on the same
 *                course copy take turns instead of tangling;
 *             3. tell the database who is acting (it stamps "last edited by" on
 *                every week, lesson and block that gets written);
 *             4. refuse if the cohort is closed or the course is archived;
 *             5. run the work. If anything fails, nothing is saved.
 *   edit()  is run() for DRAFT edits: afterwards it also records who edited and
 *           when, and raises the draft revision.
 *
 * Who may do what (decided by one rule, checked against the database on EVERY
 * request - so an admin removing an assignment takes effect on the next click):
 *   - an ADMIN: any course template, and any cohort's copy;
 *   - an INSTRUCTOR: only the copy of a cohort that is assigned to her;
 *   - anyone else: nothing.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CohortStatus, ContentKind, CourseStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PolicyService } from '../auth/policy/policy.service';
import type { DbClient } from '../common/types/db-client';
import { PrismaService } from '../prisma/prisma.service';
import { COURSE_CONTENT_MANAGE } from './course-content.constants';

/** The few facts needed to decide who may touch a course copy. */
export interface ContentRef {
  id: string;
  kind: ContentKind;
  courseId: string;
  cohortId: string | null;
}

/** A course copy as it is while we hold its lock: the facts above plus where publishing stands. */
export interface LockedContent extends ContentRef {
  draftRevision: number;
  /** The live version number (empty = nothing published yet). */
  publishedVersion: number | null;
  publishedDraftRevision: number | null;
}

/** What the permission rule looks at. */
export interface ManageResource {
  kind: ContentKind;
  cohortId: string | null;
}

/** Locks one course copy until the end of the transaction (actions take turns). */
export async function lockContent(db: DbClient, contentId: string): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "course_contents" WHERE "id" = ${contentId}::uuid FOR UPDATE`;
}

@Injectable()
export class ContentEditor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
  ) {}

  /** 404 if it does not exist, 403 if it is not this person's to open. */
  async open(user: AuthenticatedUser, contentId: string): Promise<ContentRef> {
    const content = await this.prisma.courseContent.findUnique({
      where: { id: contentId },
      select: { id: true, kind: true, courseId: true, cohortId: true },
    });
    if (!content) throw new NotFoundException('Course content not found.');

    await this.policy.assertCan<ManageResource>(user, COURSE_CONTENT_MANAGE, content);
    return content;
  }

  /** Runs `work` as the only person working on this course copy (see the notes at the top). */
  async run<T>(
    user: AuthenticatedUser,
    contentId: string,
    work: (tx: DbClient, content: LockedContent) => Promise<T>,
  ): Promise<T> {
    const ref = await this.open(user, contentId);

    return this.prisma.$transaction(async (tx) => {
      await lockContent(tx, contentId);

      // Tell the database who is acting, for this transaction only. A trigger stamps it
      // on every week, lesson and block written from here on ("last edited by").
      await tx.$queryRaw`SELECT set_config('app.user_id', ${user.id}, true)`;

      // Checked again now that we hold the lock (an assignment may have just been removed).
      await this.policy.assertCan<ManageResource>(user, COURSE_CONTENT_MANAGE, ref);
      await this.assertEditable(tx, ref);

      const locked = await tx.courseContent.findUniqueOrThrow({
        where: { id: contentId },
        select: {
          id: true,
          kind: true,
          courseId: true,
          cohortId: true,
          draftRevision: true,
          publishedVersion: true,
          publishedDraftRevision: true,
        },
      });
      return work(tx, locked);
    });
  }

  /**
   * Runs a DRAFT edit. Whatever `work` returns is sent back together with the new
   * draft revision.
   */
  async edit<T extends object>(
    user: AuthenticatedUser,
    contentId: string,
    work: (tx: DbClient, content: ContentRef) => Promise<T>,
  ): Promise<T & { draftRevision: number }> {
    return this.run(user, contentId, async (tx, content) => {
      const result = await work(tx, content);

      const saved = await tx.courseContent.update({
        where: { id: contentId },
        data: { draftRevision: { increment: 1 }, lastEditedById: user.id, lastEditedAt: new Date() },
        select: { draftRevision: true },
      });
      return { ...result, draftRevision: saved.draftRevision };
    });
  }

  /** Content of an archived course or a closed cohort is frozen. */
  private async assertEditable(tx: DbClient, content: ContentRef): Promise<void> {
    const course = await tx.course.findUniqueOrThrow({ where: { id: content.courseId }, select: { status: true } });
    if (course.status === CourseStatus.ARCHIVED) {
      throw new ConflictException('This course is archived, so its content cannot be changed.');
    }

    if (content.cohortId) {
      const cohort = await tx.cohort.findUniqueOrThrow({ where: { id: content.cohortId }, select: { status: true } });
      if (cohort.status === CohortStatus.CLOSED) {
        throw new ConflictException('This cohort is closed, so its course content cannot be changed.');
      }
    }
  }
}
EOF

# ============================================================================
cat > src/course-content/course-content.view.ts <<'EOF'
/**
 * course-content.view.ts
 * ---------------------------------------------------------------------------
 * What weeks, lessons and blocks look like in API responses. The database is
 * asked for exactly these fields, and the mappers copy them one by one.
 */
import type { BlockType, ContentKind, Prisma } from '@prisma/client';

export const weekSelect = {
  id: true,
  position: true,
  title: true,
  summary: true,
  revision: true,
} satisfies Prisma.CourseWeekSelect;

export const lessonSelect = {
  id: true,
  weekId: true,
  position: true,
  title: true,
  summary: true,
  estimatedMinutes: true,
  revision: true,
} satisfies Prisma.CourseLessonSelect;

export const blockSelect = {
  id: true,
  lessonId: true,
  position: true,
  type: true,
  instructorOnly: true,
  data: true,
  revision: true,
} satisfies Prisma.LessonBlockSelect;

type WeekRow = Prisma.CourseWeekGetPayload<{ select: typeof weekSelect }>;
type LessonRow = Prisma.CourseLessonGetPayload<{ select: typeof lessonSelect }>;
type BlockRow = Prisma.LessonBlockGetPayload<{ select: typeof blockSelect }>;

export interface WeekView {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  revision: number;
}

export interface LessonView {
  id: string;
  weekId: string;
  position: number;
  title: string;
  summary: string | null;
  estimatedMinutes: number | null;
  revision: number;
}

export interface BlockView {
  id: string;
  lessonId: string;
  position: number;
  type: BlockType;
  /** true = a note for instructors only; students never see it. */
  instructorOnly: boolean;
  data: Prisma.JsonValue;
  revision: number;
}

export const toWeekView = (row: WeekRow): WeekView => ({
  id: row.id,
  position: row.position,
  title: row.title,
  summary: row.summary,
  revision: row.revision,
});

export const toLessonView = (row: LessonRow): LessonView => ({
  id: row.id,
  weekId: row.weekId,
  position: row.position,
  title: row.title,
  summary: row.summary,
  estimatedMinutes: row.estimatedMinutes,
  revision: row.revision,
});

export const toBlockView = (row: BlockRow): BlockView => ({
  id: row.id,
  lessonId: row.lessonId,
  position: row.position,
  type: row.type,
  instructorOnly: row.instructorOnly,
  data: row.data,
  revision: row.revision,
});

/** The facts about a copy of a course that every screen needs. */
export const contentSelect = {
  id: true,
  kind: true,
  courseId: true,
  cohortId: true,
  baseTemplateVersion: true,
  draftRevision: true,
  lastEditedAt: true,
  publishedVersion: true,
  publishedAt: true,
  publishedDraftRevision: true,
  lastEditedBy: { select: { id: true, fullName: true } },
  course: { select: { id: true, title: true } },
  cohort: { select: { id: true, name: true, status: true } },
} satisfies Prisma.CourseContentSelect;

export type ContentRow = Prisma.CourseContentGetPayload<{ select: typeof contentSelect }>;

export interface ContentView {
  id: string;
  kind: ContentKind;
  course: { id: string; title: string };
  cohort: { id: string; name: string; status: string } | null;
  /** Goes up by one on every edit; the screen can show "saved" when it changes. */
  draftRevision: number;
  /** For a cohort copy: the template version it was copied from (0 = none yet). */
  baseTemplateVersion: number;
  lastEditedAt: Date | null;
  lastEditedBy: { id: string; fullName: string } | null;
  /** The live version number. null = nothing has been published yet, so students see nothing. */
  publishedVersion: number | null;
  publishedAt: Date | null;
  /** true when the draft may differ from the live version (only meaningful once something is live). */
  hasUnpublishedChanges: boolean;
}

export const toContentView = (row: ContentRow): ContentView => ({
  id: row.id,
  kind: row.kind,
  course: { id: row.course.id, title: row.course.title },
  cohort: row.cohort ? { id: row.cohort.id, name: row.cohort.name, status: row.cohort.status } : null,
  draftRevision: row.draftRevision,
  baseTemplateVersion: row.baseTemplateVersion,
  lastEditedAt: row.lastEditedAt,
  lastEditedBy: row.lastEditedBy ? { id: row.lastEditedBy.id, fullName: row.lastEditedBy.fullName } : null,
  publishedVersion: row.publishedVersion,
  publishedAt: row.publishedAt,
  hasUnpublishedChanges: row.publishedVersion !== null && row.draftRevision !== row.publishedDraftRevision,
});
EOF

# ============================================================================
cat > src/course-content/course-versions.service.ts <<'EOF'
/**
 * course-versions.service.ts
 * ---------------------------------------------------------------------------
 * Publishing a course copy and its version history.
 *
 *  DRAFT versus LIVE
 *    Edits only ever change the DRAFT. Students will only see the LIVE version,
 *    which is the last thing somebody published. Nothing a person types can reach
 *    students until "Publish" is pressed.
 *
 *  PUBLISH
 *    Saves a frozen SNAPSHOT of the whole draft as the next version number, with
 *    who published it, their role, when, a summary, and the list of what changed.
 *    It is refused when nothing changed, or when the draft was edited after the
 *    person reviewed the confirmation. Versions can never be edited or deleted.
 *
 *  COMPARE
 *    Any two of: the live version, a numbered version, the current draft. The
 *    answer lists every changed week, lesson and block, with line-by-line text
 *    differences. For the draft it also says who edited each item and when.
 *
 * Who may do this: the same people who may edit - admins, and the instructor
 * assigned to that cohort (instructors publish without admin review).
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentKind, EnrollmentStatus, Prisma, VersionSource } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import type { DbClient } from '../common/types/db-client';
import { PrismaService } from '../prisma/prisma.service';
import { ContentEditor } from './content-editor.service';
import type { PublishDto } from './dto/publish.dto';
import {
  Change,
  countChanges,
  diffSnapshots,
  summarizeChanges,
  toBrief,
} from './snapshot-diff';
import { countSnapshot, EMPTY_SNAPSHOT, ItemMeta, loadDraft, parseSnapshot, Snapshot } from './snapshot';

/** What we show about a saved version (never the snapshot itself). */
const versionSelect = {
  id: true,
  number: true,
  source: true,
  summary: true,
  changes: true,
  weekCount: true,
  lessonCount: true,
  blockCount: true,
  publishedById: true,
  publishedByRole: true,
  restoredFromNumber: true,
  createdAt: true,
} satisfies Prisma.CourseVersionSelect;

type VersionRow = Prisma.CourseVersionGetPayload<{ select: typeof versionSelect }>;

/** One side of a comparison, resolved. */
interface Side {
  version: number | null;
  snapshot: Snapshot;
  /** Only for the draft: who / when for each item. */
  meta: Map<string, ItemMeta> | null;
}

@Injectable()
export class CourseVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly editor: ContentEditor,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------ draft changes / preview

  /**
   * Everything the "Draft changes" panel and the publish confirmation need: what
   * differs between the live version and the draft (with who and when), the
   * version number a publish would create, a suggested summary, and who will see it.
   */
  async getDraftChanges(user: AuthenticatedUser, contentId: string) {
    await this.editor.open(user, contentId);

    const content = await this.prisma.courseContent.findUniqueOrThrow({
      where: { id: contentId },
      select: {
        kind: true,
        courseId: true,
        cohortId: true,
        draftRevision: true,
        publishedVersion: true,
        publishedAt: true,
        cohort: { select: { id: true, name: true } },
      },
    });

    const draft = await loadDraft(this.prisma, contentId);
    const live = await this.liveSnapshot(this.prisma, contentId, content.publishedVersion);
    const changes = diffSnapshots(live, draft.snapshot);
    const detailed = await this.withEditors(changes, draft.meta);

    const latest = await this.prisma.courseVersion.aggregate({ where: { contentId }, _max: { number: true } });

    return {
      /** Send this back when publishing, so nothing is published that was not reviewed. */
      draftRevision: content.draftRevision,
      live: content.publishedVersion === null ? null : { version: content.publishedVersion, publishedAt: content.publishedAt },
      nextVersion: (latest._max.number ?? 0) + 1,
      counts: countChanges(changes),
      changes: detailed.map(({ change, editedAt, editedBy }) => ({ ...toBrief(change), editedAt, editedBy })),
      suggestedSummary: summarizeChanges(changes),
      audience: await this.audienceOf(contentId, content),
    };
  }

  // ----------------------------------------------------------------- publish

  async publish(user: AuthenticatedUser, contentId: string, dto: PublishDto, context: RequestContext) {
    return this.editor.run(user, contentId, async (tx, content) => {
      if (dto.expectedDraftRevision !== undefined && dto.expectedDraftRevision !== content.draftRevision) {
        throw new ConflictException('The draft changed after you reviewed it. Review the changes again before publishing.');
      }

      const draft = await loadDraft(tx, contentId);
      const live = await this.liveSnapshot(tx, contentId, content.publishedVersion);
      const changes = diffSnapshots(live, draft.snapshot);
      if (changes.length === 0) {
        throw new ConflictException('There is nothing to publish: the draft is the same as the live version.');
      }

      const latest = await tx.courseVersion.aggregate({ where: { contentId }, _max: { number: true } });
      const number = (latest._max.number ?? 0) + 1;
      const counts = countSnapshot(draft.snapshot);

      const created = await tx.courseVersion.create({
        data: {
          contentId,
          number,
          source: VersionSource.PUBLISH,
          summary: dto.summary ?? summarizeChanges(changes),
          snapshot: draft.snapshot as unknown as Prisma.InputJsonObject,
          changes: changes.map(toBrief) as unknown as Prisma.InputJsonArray,
          weekCount: counts.weeks,
          lessonCount: counts.lessons,
          blockCount: counts.blocks,
          publishedById: user.id,
          publishedByRole: user.role,
        },
        select: versionSelect,
      });

      await tx.courseContent.update({
        where: { id: contentId },
        data: { publishedVersion: number, publishedAt: created.createdAt, publishedDraftRevision: content.draftRevision },
      });

      await this.audit.record(
        {
          actorId: user.id,
          action: 'course_content.published',
          entityType: 'course_content',
          entityId: contentId,
          metadata: { version: number, changes: changes.length, cohortId: content.cohortId },
          previousValue: { liveVersion: content.publishedVersion },
          newValue: { liveVersion: number },
          ipAddress: context.ipAddress,
        },
        tx,
      );

      return { version: this.toView(created, new Map([[user.id, user.fullName]]), number) };
    });
  }

  // ---------------------------------------------------------------- history

  /** The version history, newest first. */
  async listVersions(user: AuthenticatedUser, contentId: string) {
    await this.editor.open(user, contentId);

    const content = await this.prisma.courseContent.findUniqueOrThrow({
      where: { id: contentId },
      select: { draftRevision: true, publishedVersion: true, publishedDraftRevision: true },
    });
    const rows = await this.prisma.courseVersion.findMany({
      where: { contentId },
      orderBy: { number: 'desc' },
      select: versionSelect,
    });
    const names = await this.userNames(rows.map((row) => row.publishedById));

    return {
      live: content.publishedVersion,
      hasUnpublishedChanges: content.publishedVersion !== null && content.draftRevision !== content.publishedDraftRevision,
      versions: rows.map((row) => this.toView(row, names, content.publishedVersion)),
    };
  }

  /** One saved version with its whole contents ("View"). */
  async getVersion(user: AuthenticatedUser, contentId: string, number: number) {
    await this.editor.open(user, contentId);

    const content = await this.prisma.courseContent.findUniqueOrThrow({ where: { id: contentId }, select: { publishedVersion: true } });
    const row = await this.prisma.courseVersion.findUnique({
      where: { contentId_number: { contentId, number } },
      select: { ...versionSelect, snapshot: true },
    });
    if (!row) throw new NotFoundException(`Version ${number} not found.`);

    const names = await this.userNames([row.publishedById]);
    return { version: this.toView(row, names, content.publishedVersion), snapshot: parseSnapshot(row.snapshot) };
  }

  // ---------------------------------------------------------------- compare

  /** Compares two sides, each "live", "draft" or a version number. */
  async compare(user: AuthenticatedUser, contentId: string, fromRef: string, toRef: string) {
    await this.editor.open(user, contentId);

    const content = await this.prisma.courseContent.findUniqueOrThrow({ where: { id: contentId }, select: { publishedVersion: true } });
    const from = await this.resolve(contentId, fromRef, content.publishedVersion);
    const to = await this.resolve(contentId, toRef, content.publishedVersion);

    const changes = diffSnapshots(from.snapshot, to.snapshot);
    const detailed = await this.withEditors(changes, to.meta);

    return {
      from: { ref: fromRef, version: from.version },
      to: { ref: toRef, version: to.version },
      counts: countChanges(changes),
      summary: summarizeChanges(changes),
      changes: detailed.map(({ change, editedAt, editedBy }) => ({ ...change, editedAt, editedBy })),
    };
  }

  // ----------------------------------------------------------------- helpers

  private async resolve(contentId: string, ref: string, liveVersion: number | null): Promise<Side> {
    if (ref === 'draft') {
      const draft = await loadDraft(this.prisma, contentId);
      return { version: null, snapshot: draft.snapshot, meta: draft.meta };
    }

    const number = ref === 'live' ? liveVersion : Number(ref);
    if (number === null) return { version: null, snapshot: EMPTY_SNAPSHOT, meta: null }; // nothing published yet

    const row = await this.prisma.courseVersion.findUnique({
      where: { contentId_number: { contentId, number } },
      select: { snapshot: true },
    });
    if (!row) throw new NotFoundException(`Version ${number} not found.`);
    return { version: number, snapshot: parseSnapshot(row.snapshot), meta: null };
  }

  /** The live snapshot, or an empty one when nothing has been published yet. */
  private async liveSnapshot(db: DbClient, contentId: string, publishedVersion: number | null): Promise<Snapshot> {
    if (publishedVersion === null) return EMPTY_SNAPSHOT;
    const row = await db.courseVersion.findUnique({
      where: { contentId_number: { contentId, number: publishedVersion } },
      select: { snapshot: true },
    });
    if (!row) throw new NotFoundException(`The live version (${publishedVersion}) could not be found.`);
    return parseSnapshot(row.snapshot);
  }

  /** Adds "who edited it and when" to each change that still exists in the draft. */
  private async withEditors(changes: Change[], meta: Map<string, ItemMeta> | null) {
    const names = await this.userNames(
      changes.map((change) => meta?.get(change.id)?.editedById).filter((id): id is string => Boolean(id)),
    );

    return changes.map((change) => {
      const item = change.type === 'REMOVED' ? undefined : meta?.get(change.id);
      const who = item?.editedById ?? null;
      return {
        change,
        editedAt: item?.updatedAt ?? null,
        editedBy: who ? { id: who, fullName: names.get(who) ?? 'Unknown' } : null,
      };
    });
  }

  /** Who would see a publish: the students of this cohort, or - for a template - nobody yet. */
  private async audienceOf(
    contentId: string,
    content: { kind: ContentKind; courseId: string; cohortId: string | null; cohort: { id: string; name: string } | null },
  ) {
    if (content.kind === ContentKind.COHORT_COPY && content.cohort) {
      const activeStudents = await this.prisma.enrollment.count({
        where: { cohortId: content.cohort.id, status: EnrollmentStatus.ACTIVE },
      });
      return { type: 'COHORT' as const, cohort: content.cohort, activeStudents };
    }

    // A template is never shown to students; it is only the starting point for new cohorts.
    const cohortsWithCopies = await this.prisma.courseContent.count({
      where: { courseId: content.courseId, kind: ContentKind.COHORT_COPY },
    });
    return { type: 'TEMPLATE' as const, cohortsWithCopies };
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
    return new Map(users.map((user) => [user.id, user.fullName]));
  }

  private toView(row: VersionRow, names: Map<string, string>, liveVersion: number | null) {
    return {
      number: row.number,
      source: row.source,
      summary: row.summary,
      changeCount: Array.isArray(row.changes) ? row.changes.length : 0,
      counts: { weeks: row.weekCount, lessons: row.lessonCount, blocks: row.blockCount },
      publishedAt: row.createdAt,
      publishedBy: { id: row.publishedById, fullName: names.get(row.publishedById) ?? 'Unknown', role: row.publishedByRole },
      restoredFromNumber: row.restoredFromNumber,
      isLive: row.number === liveVersion,
    };
  }
}
EOF

# ============================================================================
cat > src/course-content/course-content.controller.ts <<'EOF'
/**
 * course-content.controller.ts
 * ---------------------------------------------------------------------------
 * The web addresses for building a course. Admins and instructors use the SAME
 * addresses; WHICH course copies a person may open is decided on every request
 * (an instructor only gets the copy of a cohort assigned to her).
 *
 * Finding the editable copy:
 *   GET    /api/v1/course-content/course/:courseId/template   a course's master template (admins; created on first use)
 *   GET    /api/v1/course-content/cohort/:cohortId            a cohort's own copy (created from the template on first use)
 *
 * Reading:
 *   GET    /api/v1/course-content/:contentId                  outline: weeks and their lessons
 *   GET    /api/v1/course-content/:contentId/lessons/:lessonId  one lesson with its blocks
 *
 * Weeks:
 *   POST   /api/v1/course-content/:contentId/weeks            add a week
 *   PUT    /api/v1/course-content/:contentId/weeks/order      reorder the weeks
 *   PATCH  /api/v1/course-content/:contentId/weeks/:weekId    rename / change the summary
 *   DELETE /api/v1/course-content/:contentId/weeks/:weekId    remove a week (and what is inside it)
 *
 * Lessons:
 *   POST   /api/v1/course-content/:contentId/weeks/:weekId/lessons        add a lesson
 *   PUT    /api/v1/course-content/:contentId/weeks/:weekId/lessons/order  reorder a week's lessons
 *   PATCH  /api/v1/course-content/:contentId/lessons/:lessonId            edit a lesson
 *   POST   /api/v1/course-content/:contentId/lessons/:lessonId/move       move to another place or week
 *   DELETE /api/v1/course-content/:contentId/lessons/:lessonId            remove a lesson (and its blocks)
 *
 * Blocks:
 *   POST   /api/v1/course-content/:contentId/lessons/:lessonId/blocks        add a block
 *   PUT    /api/v1/course-content/:contentId/lessons/:lessonId/blocks/order  reorder a lesson's blocks
 *   PATCH  /api/v1/course-content/:contentId/blocks/:blockId                 edit a block (send expectedRevision)
 *   DELETE /api/v1/course-content/:contentId/blocks/:blockId                 remove a block
 *
 * Publishing and versions:
 *   GET    /api/v1/course-content/:contentId/draft-changes    what a publish would change, who edited it, who will see it
 *   POST   /api/v1/course-content/:contentId/publish          publish the draft as the next version
 *   GET    /api/v1/course-content/:contentId/versions         the version history
 *   GET    /api/v1/course-content/:contentId/versions/:number one saved version, with its contents
 *   GET    /api/v1/course-content/:contentId/compare?from=&to=  compare "live", "draft" or version numbers
 *
 * Every draft change answers with the new draftRevision, so the screen can show "Saved".
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CourseContentService } from './course-content.service';
import { CourseStructureService } from './course-structure.service';
import { CourseVersionsService } from './course-versions.service';
import { CreateBlockDto, UpdateBlockDto } from './dto/block.dto';
import { CompareQuery } from './dto/compare.query';
import { CreateLessonDto, MoveLessonDto, UpdateLessonDto } from './dto/lesson.dto';
import { OrderDto } from './dto/order.dto';
import { PublishDto } from './dto/publish.dto';
import { CreateWeekDto, UpdateWeekDto } from './dto/week.dto';
import { LessonBlocksService } from './lesson-blocks.service';

const uuid = () => new ParseUUIDPipe();

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('course-content')
export class CourseContentController {
  constructor(
    private readonly content: CourseContentService,
    private readonly structure: CourseStructureService,
    private readonly blocks: LessonBlocksService,
    private readonly versions: CourseVersionsService,
  ) {}

  // ------------------------------------------------ finding the editable copy

  @Roles(Role.ADMIN)
  @Get('course/:courseId/template')
  template(@CurrentUser() admin: AuthenticatedUser, @Param('courseId', uuid()) courseId: string, @Req() req: Request) {
    return this.content.getOrCreateTemplate(admin, courseId, getRequestContext(req));
  }

  @Get('cohort/:cohortId')
  cohortCopy(@CurrentUser() user: AuthenticatedUser, @Param('cohortId', uuid()) cohortId: string, @Req() req: Request) {
    return this.content.getOrCreateCohortCopy(user, cohortId, getRequestContext(req));
  }

  // ------------------------------------------------------------------ reading

  @Get(':contentId')
  outline(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string) {
    return this.content.getOutline(user, contentId);
  }

  @Get(':contentId/lessons/:lessonId')
  lesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
  ) {
    return this.content.getLesson(user, contentId, lessonId);
  }

  // -------------------------------------------------------------------- weeks

  @Post(':contentId/weeks')
  addWeek(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string, @Body() dto: CreateWeekDto) {
    return this.structure.addWeek(user, contentId, dto);
  }

  @Put(':contentId/weeks/order')
  reorderWeeks(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string, @Body() dto: OrderDto) {
    return this.structure.reorderWeeks(user, contentId, dto);
  }

  @Patch(':contentId/weeks/:weekId')
  updateWeek(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: UpdateWeekDto,
  ) {
    return this.structure.updateWeek(user, contentId, weekId, dto);
  }

  @Delete(':contentId/weeks/:weekId')
  @HttpCode(200)
  removeWeek(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Req() req: Request,
  ) {
    return this.structure.removeWeek(user, contentId, weekId, getRequestContext(req));
  }

  // ------------------------------------------------------------------ lessons

  @Post(':contentId/weeks/:weekId/lessons')
  addLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: CreateLessonDto,
  ) {
    return this.structure.addLesson(user, contentId, weekId, dto);
  }

  @Put(':contentId/weeks/:weekId/lessons/order')
  reorderLessons(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('weekId', uuid()) weekId: string,
    @Body() dto: OrderDto,
  ) {
    return this.structure.reorderLessons(user, contentId, weekId, dto);
  }

  @Patch(':contentId/lessons/:lessonId')
  updateLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Body() dto: UpdateLessonDto,
  ) {
    return this.structure.updateLesson(user, contentId, lessonId, dto);
  }

  @Post(':contentId/lessons/:lessonId/move')
  @HttpCode(200)
  moveLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Body() dto: MoveLessonDto,
  ) {
    return this.structure.moveLesson(user, contentId, lessonId, dto);
  }

  @Delete(':contentId/lessons/:lessonId')
  @HttpCode(200)
  removeLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Req() req: Request,
  ) {
    return this.structure.removeLesson(user, contentId, lessonId, getRequestContext(req));
  }

  // ------------------------------------------------------------------- blocks

  @Post(':contentId/lessons/:lessonId/blocks')
  addBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Body() dto: CreateBlockDto,
  ) {
    return this.blocks.addBlock(user, contentId, lessonId, dto);
  }

  @Put(':contentId/lessons/:lessonId/blocks/order')
  reorderBlocks(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Body() dto: OrderDto,
  ) {
    return this.blocks.reorderBlocks(user, contentId, lessonId, dto);
  }

  @Patch(':contentId/blocks/:blockId')
  updateBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('blockId', uuid()) blockId: string,
    @Body() dto: UpdateBlockDto,
  ) {
    return this.blocks.updateBlock(user, contentId, blockId, dto);
  }

  @Delete(':contentId/blocks/:blockId')
  @HttpCode(200)
  removeBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('blockId', uuid()) blockId: string,
  ) {
    return this.blocks.removeBlock(user, contentId, blockId);
  }

  // ------------------------------------------------- publishing and versions

  @Get(':contentId/draft-changes')
  draftChanges(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string) {
    return this.versions.getDraftChanges(user, contentId);
  }

  @Post(':contentId/publish')
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Body() dto: PublishDto,
    @Req() req: Request,
  ) {
    return this.versions.publish(user, contentId, dto, getRequestContext(req));
  }

  @Get(':contentId/versions')
  listVersions(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string) {
    return this.versions.listVersions(user, contentId);
  }

  @Get(':contentId/versions/:number')
  version(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', uuid()) contentId: string,
    @Param('number', new ParseIntPipe()) number: number,
  ) {
    return this.versions.getVersion(user, contentId, number);
  }

  @Get(':contentId/compare')
  compare(@CurrentUser() user: AuthenticatedUser, @Param('contentId', uuid()) contentId: string, @Query() query: CompareQuery) {
    return this.versions.compare(user, contentId, query.from, query.to);
  }
}
EOF

# ============================================================================
cat > src/course-content/course-content.module.ts <<'EOF'
/**
 * course-content.module.ts
 * ---------------------------------------------------------------------------
 * Building a course: its master template, each cohort's own copy, the weeks,
 * lessons and blocks inside them (the draft content), and publishing them as
 * numbered versions.
 *
 * It also REGISTERS the ownership rule "who may open / edit a course copy" with
 * the permission framework (deny by default):
 *   - an admin: any template or cohort copy;
 *   - an instructor: only the copy of a cohort assigned to her;
 *   - everyone else: nothing.
 * The rule is checked against the database on EVERY request, never remembered.
 */
import { Module, OnModuleInit } from '@nestjs/common';
import { ContentKind, Role } from '@prisma/client';

import { AuthModule } from '../auth/auth.module';
import { PolicyService } from '../auth/policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContentEditor, ManageResource } from './content-editor.service';
import { COURSE_CONTENT_MANAGE } from './course-content.constants';
import { CourseContentController } from './course-content.controller';
import { CourseContentService } from './course-content.service';
import { CourseStructureService } from './course-structure.service';
import { CourseVersionsService } from './course-versions.service';
import { LessonBlocksService } from './lesson-blocks.service';

@Module({
  imports: [AuthModule],
  controllers: [CourseContentController],
  providers: [ContentEditor, CourseContentService, CourseStructureService, LessonBlocksService, CourseVersionsService],
  exports: [ContentEditor, CourseVersionsService],
})
export class CourseContentModule implements OnModuleInit {
  constructor(
    private readonly policy: PolicyService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.policy.register<ManageResource>(COURSE_CONTENT_MANAGE, async (user, resource) => {
      if (user.role === Role.ADMIN) return true;
      if (user.role !== Role.INSTRUCTOR) return false;

      // An instructor works only on a cohort's copy, and only for a cohort assigned to her.
      if (resource.kind !== ContentKind.COHORT_COPY || !resource.cohortId) return false;
      const assignments = await this.prisma.cohortInstructor.count({
        where: { cohortId: resource.cohortId, instructorId: user.id },
      });
      return assignments > 0;
    });
  }
}
EOF

echo "Batch 2B-1 files created. Now replace prisma/schema.prisma with the version provided."