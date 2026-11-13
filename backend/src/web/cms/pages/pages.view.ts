/**
 * pages.view.ts
 * ---------------------------------------------------------------------------
 * What a page looks like in admin responses.
 *
 *   state   DRAFT                    never published, or taken offline
 *           LIVE                     published, and the draft has no newer changes
 *           LIVE_WITH_DRAFT_CHANGES  published, and the draft has changes not live yet
 */
import type { Prisma } from '@prisma/client';

import { asStoredContent, completenessProblems } from './page-content';

export const pageListSelect = {
  id: true,
  path: true,
  title: true,
  status: true,
  draftRevision: true,
  publishedVersion: true,
  publishedAt: true,
  publishedDraftRevision: true,
  lastEditedAt: true,
  createdAt: true,
  updatedAt: true,
  lastEditedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.CmsPageSelect;

export const pageDetailSelect = {
  ...pageListSelect,
  draft: true,
} satisfies Prisma.CmsPageSelect;

type ListRow = Prisma.CmsPageGetPayload<{ select: typeof pageListSelect }>;
type DetailRow = Prisma.CmsPageGetPayload<{ select: typeof pageDetailSelect }>;

export type PageState = 'DRAFT' | 'LIVE' | 'LIVE_WITH_DRAFT_CHANGES';

export function stateOf(row: { status: string; draftRevision: number; publishedDraftRevision: number | null }): PageState {
  if (row.status !== 'PUBLISHED') return 'DRAFT';
  return row.draftRevision !== row.publishedDraftRevision ? 'LIVE_WITH_DRAFT_CHANGES' : 'LIVE';
}

export function toPageSummary(row: ListRow) {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    state: stateOf(row),
    hasUnpublishedChanges: stateOf(row) === 'LIVE_WITH_DRAFT_CHANGES',
    revision: row.draftRevision,
    liveVersion: row.publishedVersion,
    publishedAt: row.publishedAt,
    lastEdited: row.lastEditedAt ? { at: row.lastEditedAt, by: row.lastEditedBy } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPageDetail(row: DetailRow) {
  const content = asStoredContent(row.draft);
  const problems = completenessProblems(content);
  return {
    ...toPageSummary(row),
    /** The working copy. Send `revision` back as `baseRevision` when saving. */
    draft: content,
    /** Whether it could be published right now, and what is missing if not. */
    completeness: { canPublish: problems.length === 0, problems },
  };
}