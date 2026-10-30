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
});
