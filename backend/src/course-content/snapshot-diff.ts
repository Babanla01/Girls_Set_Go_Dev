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
