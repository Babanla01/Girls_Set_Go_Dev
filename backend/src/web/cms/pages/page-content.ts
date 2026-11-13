/**
 * page-content.ts
 * ---------------------------------------------------------------------------
 * Everything about the CONTENT of a page, as plain functions:
 *
 *   normalizeContent     checks what an editor sent (every section against its type,
 *                        every field against its limits) and returns the clean version,
 *                        or a clear list of what is wrong
 *   assertAssetsUsable   every picture must exist and come from an allowed folder
 *   completenessProblems what is still missing before the page may be PUBLISHED
 *   describeChanges      a short automatic summary for the version history
 *   usageRefsOf          which pictures the page uses (for the media library's "used on")
 *
 * A page's content is:  { seo: { title, description, imageAssetId }, sections: [ ... ] }
 * and a section is:     { id, type, hidden, fields }
 */
import { BadRequestException } from '@nestjs/common';
import { CmsMediaFolder } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import type { DbClient } from '../../../common/types/db-client';
import { MediaUsageService, UsageRef } from '../media/media-usage.service';
import { collectPaths } from './section-paths';
import { imageRef, text } from './section-fields';
import { SECTION_TYPE_KEYS, SECTION_TYPES, SectionTypeKey } from './section-types';

export const MAX_SECTIONS = 60;
/** A draft larger than this is refused with a clear message (the server's request limit is 100 KB). */
export const MAX_DRAFT_BYTES = 90_000;
/** Pictures on pages come from these folders only (people photos only through the People profiles). */
export const PAGE_IMAGE_FOLDERS: readonly CmsMediaFolder[] = [
  CmsMediaFolder.SITE,
  CmsMediaFolder.BRAND,
  CmsMediaFolder.BANNERS,
  CmsMediaFolder.PROJECTS,
];

export interface PageSeo {
  title: string;
  description: string;
  imageAssetId: string | null;
}

export interface StoredSection {
  id: string;
  type: SectionTypeKey;
  hidden: boolean;
  fields: Record<string, unknown>;
}

export interface PageContent {
  seo: PageSeo;
  sections: StoredSection[];
}

export const emptyContent = (): PageContent => ({ seo: { title: '', description: '', imageAssetId: null }, sections: [] });

const seoSchema = z
  .strictObject({ title: text(70), description: text(200), imageAssetId: imageRef })
  .default({ title: '', description: '', imageAssetId: null });

const envelopeSchema = z.strictObject({
  id: z.uuid().optional(),
  type: z.enum(SECTION_TYPE_KEYS, { error: 'Unknown section type.' }),
  hidden: z.boolean().default(false),
  fields: z.record(z.string(), z.unknown()).default({}),
});

/** "cards", 0, "title"  ->  "cards[1].title" (counted from 1, the way people count). */
function formatPath(path: readonly PropertyKey[]): string {
  return path.map((part, index) => (typeof part === 'number' ? `[${part + 1}]` : index === 0 ? String(part) : `.${String(part)}`)).join('');
}

const describeIssue = (issue: { path: readonly PropertyKey[]; message: string }) => {
  const where = formatPath(issue.path);
  return where ? `${where}: ${issue.message}` : issue.message;
};

/** Reads content that was stored in the database back into its shape (never throws). */
export function asStoredContent(value: unknown): PageContent {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const seo = (record.seo && typeof record.seo === 'object' ? record.seo : {}) as Partial<PageSeo>;
  return {
    seo: { title: seo.title ?? '', description: seo.description ?? '', imageAssetId: seo.imageAssetId ?? null },
    sections: Array.isArray(record.sections) ? (record.sections as StoredSection[]) : [],
  };
}

/**
 * Checks what an editor sent. Fields may be empty while it is a draft; they only
 * have to obey their limits and be safe. Missing ids are filled in.
 * Throws a 400 listing every problem (at most 25) when anything is wrong.
 */
export function normalizeContent(input: { seo?: unknown; sections?: unknown }): PageContent {
  const problems: string[] = [];

  const seo = seoSchema.safeParse(input.seo ?? undefined);
  if (!seo.success) problems.push(...seo.error.issues.map((issue) => `Search settings - ${describeIssue(issue)}`));

  const rawSections = input.sections ?? [];
  if (!Array.isArray(rawSections)) throw new BadRequestException('The sections must be a list.');
  if (rawSections.length > MAX_SECTIONS) problems.push(`A page can have at most ${MAX_SECTIONS} sections.`);

  const sections: StoredSection[] = [];
  const seenIds = new Set<string>();

  rawSections.slice(0, MAX_SECTIONS).forEach((raw, index) => {
    const where = `Section ${index + 1}`;

    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success) {
      problems.push(...envelope.error.issues.map((issue) => `${where} - ${describeIssue(issue)}`));
      return;
    }

    const definition = SECTION_TYPES[envelope.data.type];
    const fields = definition.schema.safeParse(envelope.data.fields);
    if (!fields.success) {
      problems.push(...fields.error.issues.map((issue) => `${where} (${definition.label}) - ${describeIssue(issue)}`));
      return;
    }

    const id = envelope.data.id ?? randomUUID();
    if (seenIds.has(id)) problems.push(`${where}: this section's id is used by another section.`);
    seenIds.add(id);

    sections.push({ id, type: envelope.data.type, hidden: envelope.data.hidden, fields: fields.data });
  });

  if (problems.length > 0) throw new BadRequestException(problems.slice(0, 25));

  const content: PageContent = { seo: seo.success ? seo.data : emptyContent().seo, sections };
  if (JSON.stringify(content).length > MAX_DRAFT_BYTES) {
    throw new BadRequestException('This page holds too much content. Split it into two pages or shorten the text.');
  }
  return content;
}

/** Every picture the page uses (search-result picture included), without repeats. */
export function pageAssetIds(content: PageContent): string[] {
  const ids = new Set<string>();
  if (content.seo.imageAssetId) ids.add(content.seo.imageAssetId);

  for (const section of content.sections) {
    const definition = SECTION_TYPES[section.type];
    if (!definition) continue;
    for (const value of collectPaths(section.fields, definition.images)) {
      if (typeof value === 'string') ids.add(value);
    }
  }
  return [...ids];
}

/** Which part of which section uses which picture (for the media library's "used on" list). */
export function usageRefsOf(content: PageContent): UsageRef[] {
  const refs: UsageRef[] = [{ field: 'seo.image', assetId: content.seo.imageAssetId }];

  for (const section of content.sections) {
    const definition = SECTION_TYPES[section.type];
    if (!definition) continue;
    for (const path of definition.images) {
      for (const value of collectPaths(section.fields, [path])) {
        if (typeof value === 'string') refs.push({ field: `${section.type}.${path}`.slice(0, 60), assetId: value });
      }
    }
  }
  return refs;
}

/** Every picture must exist and come from an allowed folder. */
export async function assertAssetsUsable(content: PageContent, usage: MediaUsageService, db: DbClient): Promise<void> {
  const ids = pageAssetIds(content);
  if (ids.length === 0) return;

  const assets = await usage.requireAssets(ids, db);
  const notAllowed = [...assets.values()].filter((asset) => !PAGE_IMAGE_FOLDERS.includes(asset.folder));
  if (notAllowed.length > 0) {
    throw new BadRequestException([
      `Pictures on pages must come from the Site, Brand, Banners or Projects folders. Not allowed here: ${notAllowed.map((asset) => asset.key).join(', ')}.`,
    ]);
  }
}

/** What is still missing before the page may be published (empty = ready). */
export function completenessProblems(content: PageContent): string[] {
  if (!content.sections.some((section) => !section.hidden)) {
    return ['Add at least one visible section before publishing.'];
  }

  const problems: string[] = [];
  content.sections.forEach((section, index) => {
    if (section.hidden) return;
    const definition = SECTION_TYPES[section.type];
    if (!definition) {
      problems.push(`Section ${index + 1}: this section type no longer exists.`);
      return;
    }
    for (const problem of definition.required(section.fields)) {
      problems.push(`Section ${index + 1} (${definition.label}): ${problem}`);
    }
  });
  return problems;
}

/** A short automatic description of what changed, for the version history. */
export function describeChanges(previous: PageContent | null, next: PageContent, titleChanged: boolean): string {
  if (!previous) {
    const count = next.sections.length;
    return `First version (${count} section${count === 1 ? '' : 's'}).`;
  }

  const before = new Map(previous.sections.map((section) => [section.id, section]));
  const nextIds = new Set(next.sections.map((section) => section.id));

  let added = 0;
  let changed = 0;
  for (const section of next.sections) {
    const old = before.get(section.id);
    if (!old) added += 1;
    else if (!isDeepStrictEqual({ t: old.type, h: old.hidden, f: old.fields }, { t: section.type, h: section.hidden, f: section.fields })) changed += 1;
  }
  const removed = previous.sections.filter((section) => !nextIds.has(section.id)).length;

  const commonBefore = previous.sections.filter((section) => nextIds.has(section.id)).map((section) => section.id);
  const commonAfter = next.sections.filter((section) => before.has(section.id)).map((section) => section.id);

  const parts: string[] = [];
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (added) parts.push(`${plural(added, 'section')} added`);
  if (removed) parts.push(`${plural(removed, 'section')} removed`);
  if (changed) parts.push(`${plural(changed, 'section')} changed`);
  if (!isDeepStrictEqual(commonBefore, commonAfter)) parts.push('sections reordered');
  if (!isDeepStrictEqual(previous.seo, next.seo)) parts.push('search settings changed');
  if (titleChanged) parts.push('title changed');

  if (parts.length === 0) return 'No visible changes.';
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}