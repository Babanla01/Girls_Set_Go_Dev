/**
 * videos.service.ts
 * ---------------------------------------------------------------------------
 * The Creative Studio video library.
 *
 *  - A video is an uploaded MP4/MOV file (kept on the server, streamed with
 *    "seek" support) or an embedded YouTube / Vimeo video.
 *  - It starts as a DRAFT and can be PUBLISHED only when complete: its file or
 *    link, a length, English captions, a 16:9 thumbnail (at least 1280 x 720,
 *    from the Videos folder) and - when learners appear - the guardian consent
 *    with the date signed. The database refuses a published video without them.
 *  - An uploaded file is checked by reading the file itself (is it really a
 *    video? how long? how big the picture?), never by trusting the browser.
 *  - Learners are only ever named as first name + last initial ("Ada O.").
 *  - A video used by a banner slide cannot be taken offline or deleted until the
 *    slide lets go of it.
 *  - Every change is audited (ids and facts only).
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { CmsContentStatus, CmsVideoCategory, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import type { AuthenticatedUser, RequestContext } from '../../../auth/auth.types';
import { formatCalendarDate, parseCalendarDate, todayInProgrammeZone } from '../../../catalog/catalog.util';
import { AuditService } from '../../../common/audit/audit.service';
import { buildPage, Paginated, toSkipTake } from '../../../common/pagination/pagination';
import type { DbClient } from '../../../common/types/db-client';
import { StorageService } from '../../../platform/storage/storage.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { MediaUsageService } from '../media/media-usage.service';
import { slugify } from '../media/media.constants';
import { RevalidationService } from '../pages/revalidation.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { ListVideosQuery } from './dto/list-videos.query';
import type { PublicVideosQuery } from './dto/public-videos.query';
import type { ReorderVideosDto } from './dto/reorder-videos.dto';
import type { UpdateVideoDto } from './dto/update-video.dto';
import { readMp4Info } from './mp4-info';
import { readRawText, streamToTempFile } from './raw-upload';
import { captionsProblem, firstNameAndInitial, normalizeText, transcriptProblem } from './video-text';
import { ExternalSource, parseExternalVideo } from './video-url';
import {
  CAPTIONS_MAX_BYTES,
  categoryFromSlug,
  TRANSCRIPT_MAX_BYTES,
  VIDEO_CATEGORIES,
  VIDEO_CONTENT_TYPES,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_SECONDS,
  VIDEO_PAGES_TO_REFRESH,
  videoFileKey,
} from './video.constants';
import {
  factsOf,
  toPublicVideo,
  toPublicVideoCard,
  toVideoDetail,
  toVideoSummary,
  videoCardSelect,
  videoDetailSelect,
  videoListSelect,
  videoProblems,
  videoPublicDetailSelect,
} from './videos.view';

const ENTITY = 'video';
const LABELS: Record<ExternalSource, string> = { YOUTUBE: 'YouTube', VIMEO: 'Vimeo' };

@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly usage: MediaUsageService,
    private readonly revalidation: RevalidationService,
  ) {}

  // ------------------------------------------------------------------- create

  async create(admin: AuthenticatedUser, dto: CreateVideoDto, context: RequestContext) {
    let externalId: string | null = null;

    if (dto.source === 'UPLOAD') {
      if (dto.url) throw new BadRequestException('An uploaded video has no link. Create it, then upload the file.');
      if (dto.durationSeconds) throw new BadRequestException('The length of an uploaded video comes from the file itself.');
    } else {
      const label = LABELS[dto.source as ExternalSource];
      if (!dto.url) throw new BadRequestException(`Paste the ${label} link of the video.`);
      const parsed = parseExternalVideo(dto.source as ExternalSource, dto.url);
      if (!parsed) throw new BadRequestException(`That is not a valid ${label} video link.`);
      externalId = parsed.id;
    }

    const tags = [...new Set(dto.alsoTagged ?? [])].filter((category) => category !== dto.category);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const slug = await this.uniqueSlug(tx, slugify(dto.title));
        const last = await tx.cmsVideo.aggregate({ where: { category: dto.category }, _max: { displayOrder: true } });

        const created = await tx.cmsVideo.create({
          data: {
            slug,
            title: dto.title,
            source: dto.source,
            category: dto.category,
            alsoTagged: tags,
            hoverDescription: dto.hoverDescription ?? '',
            externalId,
            durationSeconds: dto.durationSeconds ?? 0,
            displayOrder: (last._max.displayOrder ?? -1) + 1,
            createdById: admin.id,
          },
          select: videoDetailSelect,
        });
        await this.audit.record(
          {
            actorId: admin.id,
            action: 'video.created',
            entityType: ENTITY,
            entityId: created.id,
            metadata: { slug, source: dto.source, category: dto.category },
            ipAddress: context.ipAddress,
          },
          tx,
        );
        return created;
      });
      return { video: toVideoDetail(row, todayInProgrammeZone()) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Another video just took that name. Please try again.');
      }
      throw error;
    }
  }

  // ------------------------------------------------------------- list / detail

  async list(query: ListVideosQuery) {
    const where: Prisma.CmsVideoWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { OR: [{ category: query.category }, { alsoTagged: { has: query.category } }] } : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
      ...(query.captions === 'missing' ? { captionsUpdatedAt: null } : {}),
    };
    const today = todayInProgrammeZone();

    const [total, rows, all, published] = await Promise.all([
      this.prisma.cmsVideo.count({ where }),
      this.prisma.cmsVideo.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: videoListSelect,
      }),
      this.prisma.cmsVideo.count(),
      this.prisma.cmsVideo.count({ where: { status: CmsContentStatus.PUBLISHED } }),
    ]);

    const page: Paginated<ReturnType<typeof toVideoSummary>> = buildPage(rows.map((row) => toVideoSummary(row, today)), total, query);
    return { ...page, summary: { total: all, published, draft: all - published } };
  }

  async getOne(id: string) {
    const row = await this.prisma.cmsVideo.findUnique({ where: { id }, select: videoDetailSelect });
    if (!row) throw new NotFoundException('Video not found.');
    return { video: toVideoDetail(row, todayInProgrammeZone()) };
  }

  // ------------------------------------------------------------------- update

  async update(admin: AuthenticatedUser, id: string, dto: UpdateVideoDto, context: RequestContext) {
    if (Object.values(dto).every((value) => value === undefined)) throw new BadRequestException('Nothing to update.');
    const today = todayInProgrammeZone();

    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const current = await tx.cmsVideo.findUniqueOrThrow({ where: { id }, select: videoDetailSelect });

      const data: Record<string, unknown> = {};
      const changed: string[] = [];
      const set = (field: string, value: unknown, name: string = field) => {
        data[field] = value;
        changed.push(name);
      };

      if (dto.title !== undefined && dto.title !== current.title) set('title', dto.title);
      if (dto.hoverDescription !== undefined && dto.hoverDescription !== current.hoverDescription) {
        set('hoverDescription', dto.hoverDescription);
      }

      // Category (a move puts the video last in its new category) and extra tags.
      let category: CmsVideoCategory = current.category;
      if (dto.category !== undefined && dto.category !== current.category) {
        category = dto.category;
        const last = await tx.cmsVideo.aggregate({ where: { category }, _max: { displayOrder: true } });
        set('category', category);
        set('displayOrder', (last._max.displayOrder ?? -1) + 1, 'order');
      }
      const tags = [...new Set(dto.alsoTagged ?? current.alsoTagged)].filter((tag) => tag !== category);
      if (!isDeepStrictEqual(tags, current.alsoTagged)) set('alsoTagged', tags);

      // Embedded video: link and length. (An uploaded file tells us its own length.)
      let externalId = current.externalId;
      if (dto.url !== undefined) {
        if (current.source === 'UPLOAD') throw new BadRequestException('An uploaded video has no link.');
        const label = LABELS[current.source as ExternalSource];
        const parsed = parseExternalVideo(current.source as ExternalSource, dto.url);
        if (!parsed) throw new BadRequestException(`That is not a valid ${label} video link.`);
        if (parsed.id !== current.externalId) {
          externalId = parsed.id;
          set('externalId', parsed.id, 'link');
        }
      }
      let duration = current.durationSeconds;
      if (dto.durationSeconds !== undefined) {
        if (current.source === 'UPLOAD') throw new BadRequestException('The length of an uploaded video comes from the file itself.');
        if (dto.durationSeconds !== duration) {
          duration = dto.durationSeconds;
          set('durationSeconds', duration, 'length');
        }
      }

      // Thumbnail.
      let thumbnail = current.thumbnail ? { folder: current.thumbnail.folder as string, width: current.thumbnail.width, height: current.thumbnail.height } : null;
      if (dto.thumbnailAssetId !== undefined && dto.thumbnailAssetId !== current.thumbnailAssetId) {
        if (dto.thumbnailAssetId === null) {
          thumbnail = null;
        } else {
          const asset = (await this.usage.requireAssets([dto.thumbnailAssetId], tx)).get(dto.thumbnailAssetId);
          if (!asset || asset.folder !== 'VIDEOS') {
            throw new BadRequestException('Choose a picture from the Videos folder of the media library.');
          }
          thumbnail = { folder: asset.folder as string, width: asset.width, height: asset.height };
        }
        set('thumbnailAssetId', dto.thumbnailAssetId, 'thumbnail');
      }

      // Learners: names as first name + last initial; naming anyone means learners appear.
      let people = current.peopleInVideo;
      if (dto.peopleInVideo !== undefined) {
        const cleaned: string[] = [];
        for (const raw of dto.peopleInVideo) {
          const name = firstNameAndInitial(raw);
          if (!name) throw new BadRequestException(`"${raw}" is not a valid name. Use a first name and a last initial, like Ada O.`);
          if (!cleaned.includes(name)) cleaned.push(name);
        }
        people = cleaned;
        if (!isDeepStrictEqual(people, current.peopleInVideo)) set('peopleInVideo', people, 'people');
      }
      const showsLearners = people.length > 0 ? true : (dto.showsLearners ?? current.showsLearners);
      if (showsLearners !== current.showsLearners) set('showsLearners', showsLearners);

      // Consent date and posted date.
      let consent = current.consentSignedOn;
      if (dto.consentSignedOn !== undefined) {
        if (dto.consentSignedOn !== null && dto.consentSignedOn > today) {
          throw new BadRequestException('The consent date cannot be in the future.');
        }
        const next = dto.consentSignedOn === null ? null : parseCalendarDate(dto.consentSignedOn);
        if ((next ? formatCalendarDate(next) : null) !== (consent ? formatCalendarDate(consent) : null)) {
          consent = next;
          set('consentSignedOn', next, 'consent');
        }
      }
      if (dto.postedOn !== undefined) {
        if (dto.postedOn === null && current.status === CmsContentStatus.PUBLISHED) {
          throw new BadRequestException('A published video needs a posted date.');
        }
        const next = dto.postedOn === null ? null : parseCalendarDate(dto.postedOn);
        if ((next ? formatCalendarDate(next) : null) !== (current.postedOn ? formatCalendarDate(current.postedOn) : null)) {
          set('postedOn', next);
        }
      }

      for (const [field, value] of [
        ['showOnHome', dto.showOnHome],
        ['showOnStudio', dto.showOnStudio],
        ['showOnShowcase', dto.showOnShowcase],
        ['featured', dto.featured],
      ] as const) {
        if (value !== undefined && value !== (current as Record<string, unknown>)[field]) set(field, value);
      }

      if (changed.length === 0) return current;

      // A published video must stay complete.
      if (current.status === CmsContentStatus.PUBLISHED) {
        const problems = videoProblems(
          {
            source: current.source,
            fileKey: current.fileKey,
            externalId,
            durationSeconds: duration,
            captionsPresent: current.captionsUpdatedAt !== null,
            thumbnail,
            showsLearners,
            consentSignedOn: consent,
          },
          today,
        );
        if (problems.length > 0) throw new BadRequestException([...problems, 'To remove these, unpublish the video first.']);
      }

      const updated = await tx.cmsVideo.update({ where: { id }, data: data as Prisma.CmsVideoUncheckedUpdateInput, select: videoDetailSelect });
      await this.usage.replaceFor(ENTITY, id, `Video: ${updated.title}`, [{ field: 'thumbnail', assetId: updated.thumbnailAssetId }], tx);
      await this.audit.record(
        { actorId: admin.id, action: 'video.updated', entityType: ENTITY, entityId: id, metadata: { changed }, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });

    if (row.status === CmsContentStatus.PUBLISHED) this.refreshWebsite();
    return { video: toVideoDetail(row, today) };
  }

  // ------------------------------------------------------------- the video file

  /** Receives an uploaded video as the request body, checks it, stores it, and reads its length and size. */
  async uploadFile(admin: AuthenticatedUser, id: string, req: Request, context: RequestContext) {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const extension = VIDEO_CONTENT_TYPES[contentType];
    if (!extension) {
      throw new UnsupportedMediaTypeException('Send the video as MP4 (Content-Type: video/mp4) or MOV (Content-Type: video/quicktime).');
    }

    const video = await this.prisma.cmsVideo.findUnique({ where: { id }, select: { slug: true, source: true, fileKey: true } });
    if (!video) throw new NotFoundException('Video not found.');
    if (video.source !== 'UPLOAD') throw new ConflictException('This video is embedded from YouTube or Vimeo, so it has no file to upload.');

    const upload = await streamToTempFile(req, VIDEO_MAX_BYTES);
    try {
      const info = await readMp4Info(upload.path);
      if (!info) throw new BadRequestException('This is not a readable MP4 or MOV video file.');
      if (info.width < info.height) throw new BadRequestException('The video must be landscape (wider than it is tall).');
      if (info.durationSeconds > VIDEO_MAX_SECONDS) throw new BadRequestException('The video is too long (4 hours at most).');

      const key = videoFileKey(video.slug, extension);
      await this.storage.putFile(key, upload.path);

      const row = await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, id);
        const updated = await tx.cmsVideo.update({
          where: { id },
          data: {
            fileKey: key,
            contentType,
            sizeBytes: upload.size,
            width: info.width,
            height: info.height,
            durationSeconds: info.durationSeconds,
            fileVersion: { increment: 1 },
          },
          select: videoDetailSelect,
        });
        await this.audit.record(
          {
            actorId: admin.id,
            action: 'video.file_uploaded',
            entityType: ENTITY,
            entityId: id,
            metadata: { sizeBytes: upload.size, durationSeconds: info.durationSeconds, width: info.width, height: info.height },
            ipAddress: context.ipAddress,
          },
          tx,
        );
        return updated;
      });

      if (video.fileKey && video.fileKey !== key) await this.storage.delete(video.fileKey); // the file ending changed
      if (row.status === CmsContentStatus.PUBLISHED) this.refreshWebsite();
      return { video: toVideoDetail(row, todayInProgrammeZone()) };
    } finally {
      await rm(upload.path, { force: true });
    }
  }

  /** For the admin's own preview player (works for drafts too). */
  async adminFile(id: string) {
    const video = await this.prisma.cmsVideo.findUnique({ where: { id }, select: { fileKey: true, contentType: true } });
    if (!video || !video.fileKey) throw new NotFoundException('This video has no file.');
    return { key: video.fileKey, contentType: video.contentType ?? 'video/mp4' };
  }

  // ------------------------------------------------------- captions / transcript

  async setCaptions(admin: AuthenticatedUser, id: string, req: Request, context: RequestContext) {
    await this.requireExists(id);
    const text = normalizeText(await readRawText(req, CAPTIONS_MAX_BYTES));
    const problem = captionsProblem(text);
    if (problem) throw new BadRequestException(problem);

    return this.changeText(admin, id, context, 'video.captions_updated', { captionsVtt: text, captionsUpdatedAt: new Date() }, { bytes: Buffer.byteLength(text) });
  }

  async clearCaptions(admin: AuthenticatedUser, id: string, context: RequestContext) {
    return this.changeText(admin, id, context, 'video.captions_removed', { captionsVtt: null, captionsUpdatedAt: null }, {}, true);
  }

  async setTranscript(admin: AuthenticatedUser, id: string, req: Request, context: RequestContext) {
    await this.requireExists(id);
    const text = normalizeText(await readRawText(req, TRANSCRIPT_MAX_BYTES));
    const problem = transcriptProblem(text);
    if (problem) throw new BadRequestException(problem);

    return this.changeText(admin, id, context, 'video.transcript_updated', { transcript: text, transcriptUpdatedAt: new Date() }, { bytes: Buffer.byteLength(text) });
  }

  async clearTranscript(admin: AuthenticatedUser, id: string, context: RequestContext) {
    return this.changeText(admin, id, context, 'video.transcript_removed', { transcript: null, transcriptUpdatedAt: null }, {});
  }

  // -------------------------------------------------------- publish / unpublish

  async publish(admin: AuthenticatedUser, id: string, context: RequestContext) {
    const today = todayInProgrammeZone();

    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const video = await tx.cmsVideo.findUniqueOrThrow({ where: { id }, select: videoDetailSelect });
      if (video.status === CmsContentStatus.PUBLISHED) throw new ConflictException('This video is already published.');

      const problems = videoProblems(factsOf(video), today);
      if (video.source === 'UPLOAD' && video.fileKey && !(await this.storage.exists(video.fileKey))) {
        problems.push('The video file is missing from storage. Please upload it again.');
      }
      if (problems.length > 0) throw new BadRequestException(['This video is not ready to publish yet.', ...problems]);

      const updated = await tx.cmsVideo.update({
        where: { id },
        data: { status: CmsContentStatus.PUBLISHED, publishedAt: new Date(), postedOn: video.postedOn ?? parseCalendarDate(today) },
        select: videoDetailSelect,
      });
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'video.published',
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

    this.refreshWebsite();
    return { video: toVideoDetail(row, today) };
  }

  async unpublish(admin: AuthenticatedUser, id: string, context: RequestContext) {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const video = await tx.cmsVideo.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (video.status !== CmsContentStatus.PUBLISHED) throw new ConflictException('This video is not published.');

      const slides = await tx.cmsBannerSlide.findMany({ where: { videoId: id, status: CmsContentStatus.PUBLISHED }, select: { title: true } });
      if (slides.length > 0) {
        throw new ConflictException(`This video is used by live banner slide${slides.length === 1 ? '' : 's'} (${slides.map((slide) => slide.title).join(', ')}). Take ${slides.length === 1 ? 'it' : 'them'} offline first.`);
      }

      const updated = await tx.cmsVideo.update({
        where: { id },
        data: { status: CmsContentStatus.DRAFT, publishedAt: null },
        select: videoDetailSelect,
      });
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'video.unpublished',
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

    this.refreshWebsite();
    return { video: toVideoDetail(row, todayInProgrammeZone()) };
  }

  // ----------------------------------------------------------- reorder / delete

  /** Puts the videos filed under one category in the given order (the first id is shown first). */
  async reorder(admin: AuthenticatedUser, dto: ReorderVideosDto, context: RequestContext) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.cmsVideo.count({ where: { id: { in: dto.ids }, category: dto.category } });
      if (found !== dto.ids.length) {
        throw new BadRequestException('Every video in the list must exist and be filed under that category.');
      }
      for (const [index, id] of dto.ids.entries()) {
        await tx.cmsVideo.update({ where: { id }, data: { displayOrder: index } });
      }
      await this.audit.record(
        { actorId: admin.id, action: 'video.reordered', entityType: ENTITY, metadata: { category: dto.category, count: dto.ids.length }, ipAddress: context.ipAddress },
        tx,
      );
    });

    this.refreshWebsite();
    const rows = await this.prisma.cmsVideo.findMany({
      where: { category: dto.category },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      select: videoListSelect,
    });
    const today = todayInProgrammeZone();
    return { videos: rows.map((row) => toVideoSummary(row, today)) };
  }

  /** Deletes a DRAFT video that no banner slide uses. */
  async remove(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<void> {
    const fileKey = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const video = await tx.cmsVideo.findUniqueOrThrow({
        where: { id },
        select: { status: true, fileKey: true, slug: true, bannerSlides: { select: { title: true } } },
      });
      if (video.status === CmsContentStatus.PUBLISHED) throw new ConflictException('Unpublish this video before deleting it.');
      if (video.bannerSlides.length > 0) {
        throw new ConflictException(`This video is used by banner slide${video.bannerSlides.length === 1 ? '' : 's'} (${video.bannerSlides.map((slide) => slide.title).join(', ')}). Remove ${video.bannerSlides.length === 1 ? 'it' : 'them'} first.`);
      }

      await this.usage.removeFor(ENTITY, id, tx);
      await tx.cmsVideo.delete({ where: { id } });
      await this.audit.record(
        { actorId: admin.id, action: 'video.deleted', entityType: ENTITY, entityId: id, metadata: { slug: video.slug }, ipAddress: context.ipAddress },
        tx,
      );
      return video.fileKey;
    });

    if (fileKey) await this.storage.delete(fileKey);
  }

  // ------------------------------------------------------------------ public

  /** Published videos for the website: filters, pages, and the number of videos in each category. */
  async listPublic(query: PublicVideosQuery) {
    const base: Prisma.CmsVideoWhereInput = {
      status: CmsContentStatus.PUBLISHED,
      ...(query.showOn === 'home' ? { showOnHome: true } : {}),
      ...(query.showOn === 'studio' ? { showOnStudio: true } : {}),
      ...(query.showOn === 'showcase' ? { showOnShowcase: true } : {}),
      ...(query.featured ? { featured: true } : {}),
    };

    const category = query.category ? categoryFromSlug(query.category) : null;
    const counts = await this.categoryCounts(base);
    if (query.category && !category) return { ...buildPage([], 0, query), counts };

    const where: Prisma.CmsVideoWhereInput = category ? { ...base, OR: [{ category }, { alsoTagged: { has: category } }] } : base;
    const [total, rows] = await Promise.all([
      this.prisma.cmsVideo.count({ where }),
      this.prisma.cmsVideo.findMany({
        where,
        // In a category: the order set by the admin. "All": newest first.
        orderBy: category
          ? [{ displayOrder: 'asc' }, { postedOn: 'desc' }, { id: 'asc' }]
          : [{ postedOn: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: videoCardSelect,
      }),
    ]);
    return { ...buildPage(rows.map(toPublicVideoCard), total, query), counts };
  }

  async getPublic(slug: string) {
    const row = await this.prisma.cmsVideo.findFirst({ where: { slug, status: CmsContentStatus.PUBLISHED }, select: videoPublicDetailSelect });
    if (!row) throw new NotFoundException('Video not found.');
    return { video: toPublicVideo(row) };
  }

  /** The captions text of a PUBLISHED video. */
  async captionsOf(slug: string): Promise<string> {
    const row = await this.prisma.cmsVideo.findFirst({
      where: { slug, status: CmsContentStatus.PUBLISHED, captionsVtt: { not: null } },
      select: { captionsVtt: true },
    });
    if (!row?.captionsVtt) throw new NotFoundException('Captions not found.');
    return row.captionsVtt;
  }

  /** Finds the stored file behind a public address like "ada-demo.mp4" (published videos only). */
  async findPublicFile(file: string) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.(mp4|mov)$/.exec(file);
    if (!match) return null;

    const video = await this.prisma.cmsVideo.findFirst({
      where: { slug: match[1], status: CmsContentStatus.PUBLISHED, fileKey: { not: null } },
      select: { fileKey: true, contentType: true, fileVersion: true },
    });
    if (!video?.fileKey || !video.fileKey.endsWith(`.${match[2]}`)) return null;
    return { key: video.fileKey, contentType: video.contentType ?? 'video/mp4', version: video.fileVersion };
  }

  /** Cards for a "video row" section of a page: the featured videos, or one category. */
  async listForSection(options: { source: 'FEATURED' | 'CATEGORY'; category: string; count: number }) {
    const category = options.source === 'CATEGORY' ? categoryFromSlug(options.category) : null;
    if (options.source === 'CATEGORY' && !category) return [];

    const rows = await this.prisma.cmsVideo.findMany({
      where: {
        status: CmsContentStatus.PUBLISHED,
        ...(options.source === 'FEATURED' ? { featured: true } : { OR: [{ category: category! }, { alsoTagged: { has: category! } }] }),
      },
      orderBy: [{ postedOn: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      take: options.count,
      select: videoCardSelect,
    });
    return rows.map(toPublicVideoCard);
  }

  // ----------------------------------------------------------------- helpers

  private async changeText(
    admin: AuthenticatedUser,
    id: string,
    context: RequestContext,
    action: string,
    data: Prisma.CmsVideoUncheckedUpdateInput,
    metadata: Prisma.InputJsonValue,
    captionsRequired = false,
  ) {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const current = await tx.cmsVideo.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (captionsRequired && current.status === CmsContentStatus.PUBLISHED) {
        throw new ConflictException('A published video must keep its captions. Unpublish it first.');
      }
      const updated = await tx.cmsVideo.update({ where: { id }, data, select: videoDetailSelect });
      await this.audit.record(
        { actorId: admin.id, action, entityType: ENTITY, entityId: id, metadata, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });

    if (row.status === CmsContentStatus.PUBLISHED) this.refreshWebsite();
    return { video: toVideoDetail(row, todayInProgrammeZone()) };
  }

  private async categoryCounts(base: Prisma.CmsVideoWhereInput) {
    const categories = Object.keys(VIDEO_CATEGORIES) as CmsVideoCategory[];
    const [all, ...each] = await Promise.all([
      this.prisma.cmsVideo.count({ where: base }),
      ...categories.map((category) => this.prisma.cmsVideo.count({ where: { ...base, OR: [{ category }, { alsoTagged: { has: category } }] } })),
    ]);
    return Object.fromEntries([['all', all], ...categories.map((category, index) => [VIDEO_CATEGORIES[category].slug, each[index]])]) as Record<string, number>;
  }

  private async uniqueSlug(db: DbClient, base: string): Promise<string> {
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const slug = attempt === 1 ? base : `${base}-${attempt}`;
      if (!(await db.cmsVideo.findUnique({ where: { slug }, select: { id: true } }))) return slug;
    }
    throw new ConflictException('There are too many videos with that name. Please choose a different title.');
  }

  private async requireExists(id: string): Promise<void> {
    if (!(await this.prisma.cmsVideo.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Video not found.');
  }

  /** Takes turns with anyone else changing this video; 404 if it does not exist. */
  private async lock(tx: DbClient, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "cms_videos" WHERE id = ${id}::uuid FOR UPDATE`);
    if (rows.length === 0) throw new NotFoundException('Video not found.');
  }

  /** Asks the public website to refresh the pages that show videos. Never blocks or fails the change. */
  private refreshWebsite(): void {
    void this.revalidation.pagesChanged(VIDEO_PAGES_TO_REFRESH);
  }
}