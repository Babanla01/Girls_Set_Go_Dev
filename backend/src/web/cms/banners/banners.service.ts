/**
 * banners.service.ts
 * ---------------------------------------------------------------------------
 * The banner slides of the website's pages.
 *
 *  - A slide shows a PHOTO, or a muted looping VIDEO (an uploaded one) with a
 *    photo underneath that is shown until the video loads and to visitors who
 *    asked their device for reduced motion.
 *  - A slide can appear on several pages; each page keeps its OWN order.
 *  - A slide is shown only while it is PUBLISHED and inside its optional schedule
 *    (start and end time).
 *  - A slide must be complete to be published: a landscape picture (at least 1200
 *    px wide) from the Banners or Site folder, a published uploaded video for a
 *    video slide, and at least one page.
 *  - The pictures are registered in the media library's "used on" list.
 *  - The motion and timing rules (time per slide, fade, colour layer, pause on
 *    hover / focus / tap, reduced motion) are the website settings; see
 *    GET /api/v1/public/banners which returns them with the slides.
 *  - Every change is audited with ids only.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CmsBannerMediaType, CmsBannerPage, CmsContentStatus, Prisma } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../../../auth/auth.types';
import { AuditService } from '../../../common/audit/audit.service';
import type { DbClient } from '../../../common/types/db-client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MediaUsageService } from '../media/media-usage.service';
import { RevalidationService } from '../pages/revalidation.service';
import { SiteService } from '../site/site.service';
import { BANNER_IMAGE_FOLDERS, BANNER_IMAGE_MIN_WIDTH, BANNER_PAGES } from './banner.constants';
import type { CreateBannerDto } from './dto/create-banner.dto';
import type { ListBannersQuery } from './dto/list-banners.query';
import type { ReorderBannersDto } from './dto/reorder-banners.dto';
import type { UpdateBannerDto } from './dto/update-banner.dto';
import { slideProblems, slideSelect, toPublicSlide, toSlideView } from './banners.view';

const ENTITY = 'banner';

@Injectable()
export class BannersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly usage: MediaUsageService,
    private readonly site: SiteService,
    private readonly revalidation: RevalidationService,
  ) {}

  // ------------------------------------------------------------------- create

  async create(admin: AuthenticatedUser, dto: CreateBannerDto, context: RequestContext) {
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    this.checkSchedule(startsAt, endsAt);
    this.checkMedia(dto.mediaType, dto.videoId ?? null);

    const row = await this.prisma.$transaction(async (tx) => {
      await this.checkImage(tx, dto.imageAssetId);
      if (dto.mediaType === CmsBannerMediaType.VIDEO) await this.checkVideo(tx, dto.videoId!);

      const placements = await this.newPlacements(tx, dto.placements);
      const created = await tx.cmsBannerSlide.create({
        data: {
          title: dto.title,
          tagline: dto.tagline ?? '',
          mediaType: dto.mediaType,
          imageAssetId: dto.imageAssetId,
          videoId: dto.mediaType === CmsBannerMediaType.VIDEO ? dto.videoId : null,
          startsAt,
          endsAt,
          createdById: admin.id,
          placements: { create: placements },
        },
        select: slideSelect,
      });

      await this.syncUsage(tx, created.id, created.title, created.imageAssetId);
      await this.audit.record(
        { actorId: admin.id, action: 'banner.created', entityType: ENTITY, entityId: created.id, metadata: { pages: dto.placements }, ipAddress: context.ipAddress },
        tx,
      );
      return created;
    });
    return { slide: toSlideView(row, new Date()) };
  }

  // ------------------------------------------------------------- list / detail

  /** With a page: that page's slides in order. Without: every slide, newest first. */
  async list(query: ListBannersQuery) {
    const rows = await this.prisma.cmsBannerSlide.findMany({
      where: query.placement ? { placements: { some: { page: query.placement } } } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: slideSelect,
    });

    const position = (row: (typeof rows)[number]) => row.placements.find((placement) => placement.page === query.placement)?.position ?? 0;
    const ordered = query.placement ? [...rows].sort((a, b) => position(a) - position(b)) : rows;

    const now = new Date();
    return { slides: ordered.map((row) => toSlideView(row, now)) };
  }

  async getOne(id: string) {
    const row = await this.prisma.cmsBannerSlide.findUnique({ where: { id }, select: slideSelect });
    if (!row) throw new NotFoundException('Banner slide not found.');
    return { slide: toSlideView(row, new Date()) };
  }

  // ------------------------------------------------------------------- update

  async update(admin: AuthenticatedUser, id: string, dto: UpdateBannerDto, context: RequestContext) {
    if (Object.values(dto).every((value) => value === undefined)) throw new BadRequestException('Nothing to update.');

    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const current = await tx.cmsBannerSlide.findUniqueOrThrow({ where: { id }, select: slideSelect });

      const data: Prisma.CmsBannerSlideUncheckedUpdateInput = {};
      const changed: string[] = [];

      if (dto.title !== undefined && dto.title !== current.title) {
        data.title = dto.title;
        changed.push('title');
      }
      if (dto.tagline !== undefined && dto.tagline !== current.tagline) {
        data.tagline = dto.tagline;
        changed.push('tagline');
      }

      // Media: the picture, and the type with its video.
      const mediaType = dto.mediaType ?? current.mediaType;
      const videoId = mediaType === CmsBannerMediaType.PHOTO ? null : dto.videoId !== undefined ? dto.videoId : current.videoId;
      this.checkMedia(mediaType, videoId);
      if (mediaType !== current.mediaType) {
        data.mediaType = mediaType;
        changed.push('mediaType');
      }
      if (videoId !== current.videoId) {
        if (videoId) await this.checkVideo(tx, videoId);
        data.videoId = videoId;
        changed.push('video');
      }
      if (dto.imageAssetId !== undefined && dto.imageAssetId !== current.imageAssetId) {
        await this.checkImage(tx, dto.imageAssetId);
        data.imageAssetId = dto.imageAssetId;
        changed.push('image');
      }

      // Schedule.
      const startsAt = dto.startsAt === undefined ? current.startsAt : dto.startsAt === null ? null : new Date(dto.startsAt);
      const endsAt = dto.endsAt === undefined ? current.endsAt : dto.endsAt === null ? null : new Date(dto.endsAt);
      this.checkSchedule(startsAt, endsAt);
      if (startsAt?.getTime() !== current.startsAt?.getTime()) {
        data.startsAt = startsAt;
        changed.push('startsAt');
      }
      if (endsAt?.getTime() !== current.endsAt?.getTime()) {
        data.endsAt = endsAt;
        changed.push('endsAt');
      }

      // Pages: remove the ones no longer chosen, add new ones at the end of their page.
      let pages = current.placements.map((placement) => placement.page);
      if (dto.placements !== undefined) {
        const wanted = new Set(dto.placements);
        const removed = pages.filter((page) => !wanted.has(page));
        const kept = new Set(pages);
        const added = dto.placements.filter((page) => !kept.has(page));

        if (removed.length > 0) await tx.cmsBannerSlidePlacement.deleteMany({ where: { slideId: id, page: { in: removed } } });
        if (added.length > 0) await tx.cmsBannerSlidePlacement.createMany({ data: (await this.newPlacements(tx, added)).map((placement) => ({ slideId: id, ...placement })) });
        if (removed.length > 0 || added.length > 0) changed.push('pages');
        pages = dto.placements;
      }

      if (changed.length === 0) return current;

      // A live slide must stay complete.
      if (current.status === CmsContentStatus.PUBLISHED) {
        const next = await this.previewAfterUpdate(tx, id, data, pages);
        const problems = slideProblems(next);
        if (problems.length > 0) throw new BadRequestException([...problems, 'To remove these, unpublish the slide first.']);
      }

      const updated = await tx.cmsBannerSlide.update({ where: { id }, data, select: slideSelect });
      await this.syncUsage(tx, id, updated.title, updated.imageAssetId);
      await this.audit.record(
        { actorId: admin.id, action: 'banner.updated', entityType: ENTITY, entityId: id, metadata: { changed }, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });

    if (row.status === CmsContentStatus.PUBLISHED) this.refreshWebsite(row.placements.map((placement) => placement.page));
    return { slide: toSlideView(row, new Date()) };
  }

  // -------------------------------------------------------- publish / unpublish

  async publish(admin: AuthenticatedUser, id: string, context: RequestContext) {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const slide = await tx.cmsBannerSlide.findUniqueOrThrow({ where: { id }, select: slideSelect });
      if (slide.status === CmsContentStatus.PUBLISHED) throw new ConflictException('This slide is already published.');

      const problems = slideProblems(slide);
      if (problems.length > 0) throw new BadRequestException(['This slide is not ready to publish yet.', ...problems]);

      const updated = await tx.cmsBannerSlide.update({ where: { id }, data: { status: CmsContentStatus.PUBLISHED }, select: slideSelect });
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'banner.published',
          entityType: ENTITY,
          entityId: id,
          previousValue: { status: CmsContentStatus.DRAFT },
          newValue: { status: CmsContentStatus.PUBLISHED },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return updated;
    });

    this.refreshWebsite(row.placements.map((placement) => placement.page));
    return { slide: toSlideView(row, new Date()) };
  }

  async unpublish(admin: AuthenticatedUser, id: string, context: RequestContext) {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const slide = await tx.cmsBannerSlide.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (slide.status !== CmsContentStatus.PUBLISHED) throw new ConflictException('This slide is not published.');

      const updated = await tx.cmsBannerSlide.update({ where: { id }, data: { status: CmsContentStatus.DRAFT }, select: slideSelect });
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'banner.unpublished',
          entityType: ENTITY,
          entityId: id,
          previousValue: { status: CmsContentStatus.PUBLISHED },
          newValue: { status: CmsContentStatus.DRAFT },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return updated;
    });

    this.refreshWebsite(row.placements.map((placement) => placement.page));
    return { slide: toSlideView(row, new Date()) };
  }

  // ----------------------------------------------------------- reorder / delete

  /** Puts the slides of one page in the given order (the first id is shown first). */
  async reorder(admin: AuthenticatedUser, dto: ReorderBannersDto, context: RequestContext) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.cmsBannerSlidePlacement.count({ where: { page: dto.placement, slideId: { in: dto.ids } } });
      if (found !== dto.ids.length) throw new BadRequestException('Every slide in the list must exist and be shown on that page.');

      for (const [index, slideId] of dto.ids.entries()) {
        await tx.cmsBannerSlidePlacement.update({ where: { slideId_page: { slideId, page: dto.placement } }, data: { position: index } });
      }
      await this.audit.record(
        { actorId: admin.id, action: 'banner.reordered', entityType: ENTITY, metadata: { page: dto.placement, count: dto.ids.length }, ipAddress: context.ipAddress },
        tx,
      );
    });

    this.refreshWebsite([dto.placement]);
    return this.list({ placement: dto.placement });
  }

  /** Deletes a DRAFT slide. A published one must be unpublished first. */
  async remove(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const slide = await tx.cmsBannerSlide.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (slide.status === CmsContentStatus.PUBLISHED) throw new ConflictException('Unpublish this slide before deleting it.');

      await this.usage.removeFor(ENTITY, id, tx);
      await tx.cmsBannerSlide.delete({ where: { id } }); // its page placements go with it
      await this.audit.record(
        { actorId: admin.id, action: 'banner.deleted', entityType: ENTITY, entityId: id, ipAddress: context.ipAddress },
        tx,
      );
    });
  }

  // ------------------------------------------------------------------ public

  /** The live slides of one page, in order, with the banner rules from the website settings. */
  async listPublic(page: CmsBannerPage) {
    const now = new Date();
    const rows = await this.prisma.cmsBannerSlide.findMany({
      where: {
        status: CmsContentStatus.PUBLISHED,
        placements: { some: { page } },
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      select: slideSelect,
    });

    const position = (row: (typeof rows)[number]) => row.placements.find((placement) => placement.page === page)?.position ?? 0;
    const slides = rows
      .filter((row) => row.mediaType === CmsBannerMediaType.PHOTO || row.video?.status === 'PUBLISHED') // never a video that was taken offline
      .sort((a, b) => position(a) - position(b) || a.createdAt.getTime() - b.createdAt.getTime())
      .map(toPublicSlide);

    const settings = await this.site.publicView();
    return { page, label: BANNER_PAGES[page].label, banner: settings.banner, tagline: settings.tagline, slides };
  }

  // ----------------------------------------------------------------- helpers

  private checkSchedule(startsAt: Date | null, endsAt: Date | null): void {
    if (startsAt && endsAt && endsAt <= startsAt) throw new BadRequestException('The end time must be after the start time.');
  }

  private checkMedia(mediaType: CmsBannerMediaType, videoId: string | null): void {
    if (mediaType === CmsBannerMediaType.VIDEO && !videoId) throw new BadRequestException('Choose the video for a video slide.');
    if (mediaType === CmsBannerMediaType.PHOTO && videoId) throw new BadRequestException('A photo slide has no video.');
  }

  /** The picture must exist, come from the Banners or Site folder, and be landscape and wide enough. */
  private async checkImage(db: DbClient, assetId: string): Promise<void> {
    const asset = (await this.usage.requireAssets([assetId], db)).get(assetId);
    if (!asset || !BANNER_IMAGE_FOLDERS.includes(asset.folder)) {
      throw new BadRequestException('Choose a picture from the Banners or Site folder of the media library.');
    }
    if (asset.width < BANNER_IMAGE_MIN_WIDTH || asset.width < asset.height) {
      throw new BadRequestException(`The banner picture must be landscape and at least ${BANNER_IMAGE_MIN_WIDTH} px wide.`);
    }
  }

  /** The video must exist and be an uploaded one (only those can play as a muted loop). */
  private async checkVideo(db: DbClient, videoId: string): Promise<void> {
    const video = await db.cmsVideo.findUnique({ where: { id: videoId }, select: { source: true } });
    if (!video) throw new BadRequestException('That video does not exist.');
    if (video.source !== 'UPLOAD') throw new BadRequestException('Only an uploaded video can play as a banner (muted loop).');
  }

  /** New page placements go at the end of each page's slides. */
  private async newPlacements(db: DbClient, pages: CmsBannerPage[]) {
    const placements: { page: CmsBannerPage; position: number }[] = [];
    for (const page of new Set(pages)) {
      const last = await db.cmsBannerSlidePlacement.aggregate({ where: { page }, _max: { position: true } });
      placements.push({ page, position: (last._max.position ?? -1) + 1 });
    }
    return placements;
  }

  /** How the slide WILL look after the pending changes, to check a live slide stays complete. */
  private async previewAfterUpdate(db: DbClient, id: string, data: Prisma.CmsBannerSlideUncheckedUpdateInput, pages: CmsBannerPage[]) {
    const current = await db.cmsBannerSlide.findUniqueOrThrow({ where: { id }, select: slideSelect });
    const imageId = (data.imageAssetId as string | undefined) ?? current.imageAssetId;
    const videoId = data.videoId === undefined ? current.videoId : (data.videoId as string | null);

    const image = imageId === current.imageAssetId ? current.image : await db.cmsMediaAsset.findUniqueOrThrow({ where: { id: imageId }, select: { id: true, folder: true, key: true, version: true, altText: true, width: true, height: true } });
    const video = videoId === current.videoId ? current.video : videoId ? await db.cmsVideo.findUnique({ where: { id: videoId }, select: slideSelect.video.select }) : null;

    return {
      mediaType: (data.mediaType as CmsBannerMediaType | undefined) ?? current.mediaType,
      image,
      video,
      placements: pages.map((page) => ({ page, position: 0 })),
      startsAt: data.startsAt === undefined ? current.startsAt : (data.startsAt as Date | null),
      endsAt: data.endsAt === undefined ? current.endsAt : (data.endsAt as Date | null),
    };
  }

  private syncUsage(db: DbClient, slideId: string, title: string, imageAssetId: string) {
    return this.usage.replaceFor(ENTITY, slideId, `Banner: ${title}`, [{ field: 'image', assetId: imageAssetId }], db);
  }

  /** Takes turns with anyone else changing this slide; 404 if it does not exist. */
  private async lock(tx: DbClient, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "cms_banner_slides" WHERE id = ${id}::uuid FOR UPDATE`);
    if (rows.length === 0) throw new NotFoundException('Banner slide not found.');
  }

  /** Asks the public website to refresh the pages whose banner changed. Never blocks or fails the change. */
  private refreshWebsite(pages: CmsBannerPage[]): void {
    void this.revalidation.pagesChanged([...new Set(pages)].map((page) => BANNER_PAGES[page].path));
  }
}