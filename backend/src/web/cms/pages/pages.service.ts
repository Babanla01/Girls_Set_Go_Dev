/**
 * pages.service.ts
 * ---------------------------------------------------------------------------
 * The website editor's pages: a working copy (DRAFT) and numbered, frozen,
 * PUBLISHED versions. Visitors only ever see a published version.
 *
 *  - AUTOSAVE: saving the draft needs the revision number the editor last saw
 *    ("baseRevision"). If someone else saved in between, the save is refused with
 *    a clear message instead of silently overwriting their work.
 *  - PUBLISH is all-or-nothing: the page must be complete, every picture must
 *    exist, then a new numbered version is written, the page goes live and the
 *    audit entry is saved together. The website is then told to refresh.
 *  - HISTORY: every published version is kept forever (the database refuses to
 *    change or delete one). RESTORE copies an old version into the DRAFT - it does
 *    not go live until someone publishes it.
 *  - Pages that were ever published cannot be deleted (their history must stay);
 *    take them offline instead. The home page cannot be taken offline.
 *  - Pictures a page uses (draft and live) are registered in the media library's
 *    "used on" list, so a picture in use can never be deleted by accident.
 *  - Autosaves are NOT audited (there would be thousands); publishing, restoring,
 *    taking offline, creating and deleting are.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CmsContentStatus, Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import type { AuthenticatedUser, RequestContext } from '../../../auth/auth.types';
import { AuditService } from '../../../common/audit/audit.service';
import { buildPage, Paginated, toSkipTake } from '../../../common/pagination/pagination';
import type { DbClient } from '../../../common/types/db-client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MediaUsageService } from '../media/media-usage.service';
import type { CreatePageDto } from './dto/create-page.dto';
import type { ListPagesQuery } from './dto/list-pages.query';
import type { PublishPageDto } from './dto/publish-page.dto';
import type { RestoreVersionDto } from './dto/restore-version.dto';
import type { SaveDraftDto } from './dto/save-draft.dto';
import type { UpdatePageDto } from './dto/update-page.dto';
import {
  assertAssetsUsable,
  asStoredContent,
  completenessProblems,
  describeChanges,
  emptyContent,
  normalizeContent,
  PageContent,
  usageRefsOf,
} from './page-content';
import { HOME_PATH, normalizePagePath, pathProblem } from './page-paths';
import { PageRenderService } from './page-render.service';
import { PreviewTokenService } from './preview-token.service';
import { RevalidationService } from './revalidation.service';
import { pageDetailSelect, pageListSelect, stateOf, toPageDetail, toPageSummary } from './pages.view';
import { SECTION_TYPES } from './section-types';

const ENTITY = 'page';

type PageRow = Prisma.CmsPageGetPayload<{ select: typeof pageDetailSelect }>;

@Injectable()
export class PagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly usage: MediaUsageService,
    private readonly renderer: PageRenderService,
    private readonly previews: PreviewTokenService,
    private readonly revalidation: RevalidationService,
  ) {}

  // -------------------------------------------------------------- section types

  /** The catalog the editor builds its "add a section" menu and forms from. */
  sectionTypes() {
    return {
      sectionTypes: Object.entries(SECTION_TYPES).map(([type, definition]) => ({
        type,
        label: definition.label,
        description: definition.description,
        /** A new section of this type starts with these values. */
        defaults: definition.schema.parse({}),
        /** The fields and limits, as JSON Schema, for building the form. */
        schema: z.toJSONSchema(definition.schema, { io: 'input', unrepresentable: 'any' }),
      })),
    };
  }

  // ------------------------------------------------------------------- create

  async create(admin: AuthenticatedUser, dto: CreatePageDto, context: RequestContext) {
    const path = normalizePagePath(dto.path);
    const problem = pathProblem(path);
    if (problem) throw new BadRequestException(problem);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.cmsPage.create({
          data: {
            path,
            title: dto.title,
            draft: emptyContent() as unknown as Prisma.InputJsonValue,
            createdById: admin.id,
            lastEditedById: admin.id,
            lastEditedAt: new Date(),
          },
          select: pageDetailSelect,
        });
        await this.audit.record(
          { actorId: admin.id, action: 'page.created', entityType: ENTITY, entityId: created.id, metadata: { path }, ipAddress: context.ipAddress },
          tx,
        );
        return created;
      });
      return { page: toPageDetail(row) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A page with that address already exists.');
      }
      throw error;
    }
  }

  // ------------------------------------------------------------- list / detail

  async list(query: ListPagesQuery): Promise<Paginated<ReturnType<typeof toPageSummary>>> {
    const where: Prisma.CmsPageWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? { OR: [{ title: { contains: query.search, mode: 'insensitive' } }, { path: { contains: query.search.toLowerCase() } }] }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.cmsPage.count({ where }),
      this.prisma.cmsPage.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: pageListSelect,
      }),
    ]);
    return buildPage(rows.map(toPageSummary), total, query);
  }

  async getOne(id: string) {
    const row = await this.prisma.cmsPage.findUnique({ where: { id }, select: pageDetailSelect });
    if (!row) throw new NotFoundException('Page not found.');
    return { page: toPageDetail(row) };
  }

  // ------------------------------------------------------- title / address

  /** Change the title, or the address (the address only while the page has never been published). */
  async updateDetails(admin: AuthenticatedUser, id: string, dto: UpdatePageDto, context: RequestContext) {
    if (dto.title === undefined && dto.path === undefined) throw new BadRequestException('Nothing to update.');

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, id);
        const current = await tx.cmsPage.findUniqueOrThrow({ where: { id }, select: { path: true, title: true, publishedVersion: true } });

        const data: Prisma.CmsPageUpdateInput = {};
        const changed: string[] = [];

        if (dto.path !== undefined) {
          const path = normalizePagePath(dto.path);
          if (path !== current.path) {
            const problem = pathProblem(path);
            if (problem) throw new BadRequestException(problem);

            const everPublished = current.publishedVersion !== null || (await tx.cmsPageVersion.count({ where: { pageId: id } })) > 0;
            if (everPublished) {
              throw new ConflictException('This page has been published before, so its address can no longer change (links to it would break).');
            }
            data.path = path;
            changed.push('path');
          }
        }
        if (dto.title !== undefined && dto.title !== current.title) {
          data.title = dto.title;
          data.draftRevision = { increment: 1 }; // the title is part of what gets published
          changed.push('title');
        }
        if (changed.length === 0) return tx.cmsPage.findUniqueOrThrow({ where: { id }, select: pageDetailSelect });

        data.lastEditedBy = { connect: { id: admin.id } };
        data.lastEditedAt = new Date();
        const updated = await tx.cmsPage.update({ where: { id }, data, select: pageDetailSelect });
        await this.syncUsage(tx, updated, asStoredContent(updated.draft), await this.liveContent(tx, updated));
        await this.audit.record(
          { actorId: admin.id, action: 'page.updated', entityType: ENTITY, entityId: id, metadata: { changed }, ipAddress: context.ipAddress },
          tx,
        );
        return updated;
      });
      return { page: toPageDetail(row) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A page with that address already exists.');
      }
      throw error;
    }
  }

  // --------------------------------------------------------------- autosave

  /**
   * Saves the draft. Send only what changed: the title, the search settings, and/or the WHOLE list
   * of sections (in order, with their ids). `baseRevision` is the revision the editor last saw.
   */
  async saveDraft(admin: AuthenticatedUser, id: string, dto: SaveDraftDto) {
    if (dto.title === undefined && dto.seo === undefined && dto.sections === undefined) {
      throw new BadRequestException('Nothing to save.');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const current = await tx.cmsPage.findUniqueOrThrow({ where: { id }, select: pageDetailSelect });
      if (current.draftRevision !== dto.baseRevision) throw this.staleError(current);

      const existing = asStoredContent(current.draft);
      const content = normalizeContent({ seo: dto.seo ?? existing.seo, sections: dto.sections ?? existing.sections });
      await assertAssetsUsable(content, this.usage, tx);

      const title = dto.title ?? current.title;
      const row =
        isDeepStrictEqual(content, existing) && title === current.title
          ? current // nothing really changed: keep the revision (autosave of identical content is a no-op)
          : await tx.cmsPage.update({
              where: { id },
              data: {
                title,
                draft: content as unknown as Prisma.InputJsonValue,
                draftRevision: { increment: 1 },
                lastEditedBy: { connect: { id: admin.id } },
                lastEditedAt: new Date(),
              },
              select: pageDetailSelect,
            });

      if (row !== current) await this.syncUsage(tx, row, content, await this.liveContent(tx, row));

      return {
        revision: row.draftRevision,
        savedAt: row.lastEditedAt,
        savedBy: row.lastEditedBy,
        hasUnpublishedChanges: stateOf(row) === 'LIVE_WITH_DRAFT_CHANGES',
        /** Now with the ids the server gave to any new sections. */
        sections: content.sections,
        seo: content.seo,
      };
    });
  }

  // ---------------------------------------------------------------- publish

  async publish(admin: AuthenticatedUser, id: string, dto: PublishPageDto, context: RequestContext) {
    const { row, path } = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const page = await tx.cmsPage.findUniqueOrThrow({ where: { id }, select: pageDetailSelect });
      if (page.draftRevision !== dto.baseRevision) throw this.staleError(page);
      if (page.status === CmsContentStatus.PUBLISHED && page.publishedDraftRevision === page.draftRevision) {
        throw new ConflictException('There are no new changes to publish.'); // also stops a double click making a duplicate version
      }

      const content = asStoredContent(page.draft);
      const problems = completenessProblems(content);
      if (problems.length > 0) throw new BadRequestException(['This page is not ready to publish yet.', ...problems]);
      await assertAssetsUsable(content, this.usage, tx);

      // What changed compared with the version that is live now.
      const previous = page.publishedVersion
        ? await tx.cmsPageVersion.findUnique({ where: { pageId_number: { pageId: id, number: page.publishedVersion } }, select: { snapshot: true } })
        : null;
      const previousTitle = previous ? (previous.snapshot as { title?: string }).title : undefined;
      const summary = describeChanges(
        previous ? asStoredContent(previous.snapshot) : null,
        content,
        previousTitle !== undefined && previousTitle !== page.title,
      );

      const last = await tx.cmsPageVersion.aggregate({ where: { pageId: id }, _max: { number: true } });
      const number = (last._max.number ?? 0) + 1;

      await tx.cmsPageVersion.create({
        data: {
          pageId: id,
          number,
          note: dto.note || null,
          summary,
          snapshot: { title: page.title, ...content } as unknown as Prisma.InputJsonValue,
          sectionCount: content.sections.length,
          publishedById: admin.id,
          publishedByRole: admin.role,
        },
      });

      const updated = await tx.cmsPage.update({
        where: { id },
        data: {
          status: CmsContentStatus.PUBLISHED,
          publishedVersion: number,
          publishedAt: new Date(),
          publishedDraftRevision: page.draftRevision,
        },
        select: pageDetailSelect,
      });

      await this.syncUsage(tx, updated, content, content);
      await this.audit.record(
        {
          actorId: admin.id,
          actorRole: admin.role,
          action: 'page.published',
          entityType: ENTITY,
          entityId: id,
          metadata: { path: page.path, version: number, summary },
          previousValue: { version: page.publishedVersion },
          newValue: { version: number },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { row: updated, path: page.path };
    });

    void this.revalidation.pagesChanged([path]); // tell the website; never blocks or fails the publish
    return { page: toPageDetail(row) };
  }

  /** Takes a live page offline. Its versions are kept; it can be published again. */
  async unpublish(admin: AuthenticatedUser, id: string, context: RequestContext) {
    const { row, path } = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const page = await tx.cmsPage.findUniqueOrThrow({ where: { id }, select: pageDetailSelect });
      if (page.status !== CmsContentStatus.PUBLISHED) throw new ConflictException('This page is not live.');
      if (page.path === HOME_PATH) throw new ConflictException('The home page cannot be taken offline. Publish a new version instead.');

      const updated = await tx.cmsPage.update({
        where: { id },
        data: { status: CmsContentStatus.DRAFT, publishedVersion: null, publishedAt: null, publishedDraftRevision: null },
        select: pageDetailSelect,
      });
      await this.syncUsage(tx, updated, asStoredContent(updated.draft), null);
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'page.unpublished',
          entityType: ENTITY,
          entityId: id,
          metadata: { path: page.path },
          previousValue: { version: page.publishedVersion },
          newValue: { version: null },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { row: updated, path: page.path };
    });

    void this.revalidation.pagesChanged([path]);
    return { page: toPageDetail(row) };
  }

  // ----------------------------------------------------------------- history

  async listVersions(id: string) {
    const page = await this.prisma.cmsPage.findUnique({ where: { id }, select: { publishedVersion: true } });
    if (!page) throw new NotFoundException('Page not found.');

    const rows = await this.prisma.cmsPageVersion.findMany({
      where: { pageId: id },
      orderBy: { number: 'desc' },
      select: {
        number: true,
        note: true,
        summary: true,
        sectionCount: true,
        publishedByRole: true,
        createdAt: true,
        publishedBy: { select: { id: true, fullName: true } },
      },
    });
    return {
      versions: rows.map((row) => ({
        number: row.number,
        note: row.note,
        summary: row.summary,
        sectionCount: row.sectionCount,
        publishedAt: row.createdAt,
        publishedBy: { ...row.publishedBy, role: row.publishedByRole },
        isLive: row.number === page.publishedVersion,
      })),
    };
  }

  /** One version with its full content (to look at, or to compare). */
  async getVersion(id: string, number: number) {
    const row = await this.prisma.cmsPageVersion.findUnique({
      where: { pageId_number: { pageId: id, number } },
      select: {
        number: true,
        note: true,
        summary: true,
        snapshot: true,
        sectionCount: true,
        createdAt: true,
        publishedByRole: true,
        publishedBy: { select: { id: true, fullName: true } },
        page: { select: { publishedVersion: true } },
      },
    });
    if (!row) throw new NotFoundException('Version not found.');

    const snapshot = row.snapshot as { title?: string };
    return {
      version: {
        number: row.number,
        note: row.note,
        summary: row.summary,
        sectionCount: row.sectionCount,
        publishedAt: row.createdAt,
        publishedBy: { ...row.publishedBy, role: row.publishedByRole },
        isLive: row.number === row.page.publishedVersion,
        title: snapshot.title ?? null,
        content: asStoredContent(row.snapshot),
      },
    };
  }

  /**
   * Copies an old version into the DRAFT (it does NOT go live; publish it when you are happy).
   * Refused if a picture it uses has since been deleted.
   */
  async restoreVersion(admin: AuthenticatedUser, id: string, number: number, dto: RestoreVersionDto, context: RequestContext) {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const page = await tx.cmsPage.findUniqueOrThrow({ where: { id }, select: pageDetailSelect });
      if (page.draftRevision !== dto.baseRevision) throw this.staleError(page);

      const version = await tx.cmsPageVersion.findUnique({ where: { pageId_number: { pageId: id, number } }, select: { snapshot: true } });
      if (!version) throw new NotFoundException('Version not found.');

      let content: PageContent;
      try {
        content = normalizeContent(asStoredContent(version.snapshot));
        await assertAssetsUsable(content, this.usage, tx);
      } catch (error) {
        const detail = error instanceof BadRequestException ? (error.getResponse() as { message?: string | string[] }).message : undefined;
        throw new ConflictException([
          `Version ${number} cannot be restored as it is.`,
          ...(Array.isArray(detail) ? detail : detail ? [detail] : []),
        ]);
      }

      const title = (version.snapshot as { title?: string }).title ?? page.title;
      const updated = await tx.cmsPage.update({
        where: { id },
        data: {
          title,
          draft: content as unknown as Prisma.InputJsonValue,
          draftRevision: { increment: 1 },
          lastEditedBy: { connect: { id: admin.id } },
          lastEditedAt: new Date(),
        },
        select: pageDetailSelect,
      });
      await this.syncUsage(tx, updated, content, await this.liveContent(tx, updated));
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'page.draft_restored',
          entityType: ENTITY,
          entityId: id,
          metadata: { path: page.path, fromVersion: number },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return updated;
    });
    return { page: toPageDetail(row) };
  }

  // ------------------------------------------------------------------ delete

  /** Deletes a page that was NEVER published. Published pages keep their history. */
  async remove(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const page = await tx.cmsPage.findUniqueOrThrow({ where: { id }, select: { path: true } });

      if ((await tx.cmsPageVersion.count({ where: { pageId: id } })) > 0) {
        throw new ConflictException('This page was published before, so its history must be kept. Take it offline instead.');
      }

      await this.usage.removeFor(ENTITY, id, tx);
      await tx.cmsPage.delete({ where: { id } });
      await this.audit.record(
        { actorId: admin.id, action: 'page.deleted', entityType: ENTITY, entityId: id, metadata: { path: page.path }, ipAddress: context.ipAddress },
        tx,
      );
    });
  }

  // ----------------------------------------------------------------- preview

  /** A 30-minute link that lets the website show this page's DRAFT. */
  async createPreviewLink(id: string) {
    const page = await this.prisma.cmsPage.findUnique({ where: { id }, select: { id: true, path: true } });
    if (!page) throw new NotFoundException('Page not found.');

    const { token, expiresAt } = this.previews.create(page.id);
    return { preview: { token, expiresAt, path: page.path, apiUrl: `/api/v1/public/page-preview/${token}` } };
  }

  /** The draft, rendered exactly as it would look when published. */
  async renderPreview(token: string) {
    const pageId = this.previews.verify(token);
    if (!pageId) throw new NotFoundException('This preview link is invalid or has expired.');

    const page = await this.prisma.cmsPage.findUnique({ where: { id: pageId }, select: { path: true, title: true, draft: true } });
    if (!page) throw new NotFoundException('This preview link is invalid or has expired.');

    return { page: await this.renderer.render(page, asStoredContent(page.draft), { version: null, publishedAt: null, preview: true }) };
  }

  // ------------------------------------------------------------------ public

  /** A live page for the public website, by its address. */
  async getPublic(rawPath: string) {
    const path = normalizePagePath(rawPath);
    const page = await this.prisma.cmsPage.findUnique({
      where: { path },
      select: { id: true, path: true, title: true, status: true, publishedVersion: true, publishedAt: true },
    });
    if (!page || page.status !== CmsContentStatus.PUBLISHED || page.publishedVersion === null) {
      throw new NotFoundException('Page not found.');
    }

    const version = await this.prisma.cmsPageVersion.findUnique({
      where: { pageId_number: { pageId: page.id, number: page.publishedVersion } },
      select: { snapshot: true },
    });
    if (!version) throw new NotFoundException('Page not found.');

    const title = (version.snapshot as { title?: string }).title ?? page.title;
    return {
      page: await this.renderer.render({ path: page.path, title }, asStoredContent(version.snapshot), {
        version: page.publishedVersion,
        publishedAt: page.publishedAt,
        preview: false,
      }),
    };
  }

  /** Every live page (address, title, date), for the website's menu and sitemap. */
  async listPublic() {
    const rows = await this.prisma.cmsPage.findMany({
      where: { status: CmsContentStatus.PUBLISHED },
      orderBy: { path: 'asc' },
      select: { path: true, title: true, publishedAt: true },
    });
    return { pages: rows.map((row) => ({ path: row.path, title: row.title, publishedAt: row.publishedAt })) };
  }

  // ----------------------------------------------------------------- helpers

  /** Takes turns with anyone else changing this page; 404 if it does not exist. */
  private async lock(tx: DbClient, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "cms_pages" WHERE id = ${id}::uuid FOR UPDATE`);
    if (rows.length === 0) throw new NotFoundException('Page not found.');
  }

  private staleError(page: PageRow): ConflictException {
    const who = page.lastEditedBy?.fullName ? ` (last saved by ${page.lastEditedBy.fullName})` : '';
    return new ConflictException(`This page was changed by someone else${who}. Reload it to see their changes, then try again.`);
  }

  /** The content of the version that is live now (null when the page is not live). */
  private async liveContent(db: DbClient, page: { id: string; publishedVersion: number | null }): Promise<PageContent | null> {
    if (page.publishedVersion === null) return null;
    const version = await db.cmsPageVersion.findUnique({
      where: { pageId_number: { pageId: page.id, number: page.publishedVersion } },
      select: { snapshot: true },
    });
    return version ? asStoredContent(version.snapshot) : null;
  }

  /** Registers every picture the draft AND the live version use. */
  private syncUsage(db: DbClient, page: { id: string; path: string; title: string }, draft: PageContent, live: PageContent | null) {
    return this.usage.replaceFor(
      ENTITY,
      page.id,
      `Page: ${page.title} (${page.path})`,
      [...usageRefsOf(draft), ...(live ? usageRefsOf(live) : [])],
      db,
    );
  }
}