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
