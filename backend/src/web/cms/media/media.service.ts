/**
 * media.service.ts
 * ---------------------------------------------------------------------------
 * The media library: uploading, replacing, describing, listing and deleting
 * pictures, and serving them to the public website.
 *
 * Rules (from the website design):
 *  - Every picture has a PERMANENT key such as "people/queen-tane.jpg". Replacing
 *    the picture keeps the key, so no page ever breaks. The version number goes
 *    up and is part of the public address, so browsers load the new picture at once.
 *  - Alt text is required (the database refuses an empty one).
 *  - Pictures in the PEOPLE and PROJECTS folders need the consent confirmed.
 *  - A picture that is in use anywhere cannot be deleted - replace it instead.
 *  - Hidden camera data (GPS and more) is removed from every upload.
 *  - Every change is audited (ids and keys only, never a person's details).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CmsMediaFolder, Prisma } from '@prisma/client';
import type { Readable } from 'node:stream';

import type { AuthenticatedUser, RequestContext } from '../../../auth/auth.types';
import { AuditService } from '../../../common/audit/audit.service';
import type { DbClient } from '../../../common/types/db-client';
import { buildPage, Paginated, toSkipTake } from '../../../common/pagination/pagination';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../../platform/storage/storage.service';
import type { ListMediaQuery } from './dto/list-media.query';
import type { ReplaceMediaDto } from './dto/replace-media.dto';
import type { UpdateMediaDto } from './dto/update-media.dto';
import type { UploadMediaDto } from './dto/upload-media.dto';
import { MediaImageService } from './media-image.service';
import { CONSENT_FOLDERS, slugify, snapWidth } from './media.constants';
import { mediaDetailSelect, mediaListSelect, toMediaDetail, toMediaView } from './media.view';
import type { UploadedPicture } from './uploaded-picture';

const CONSENT_REQUIRED_MESSAGE =
  'Please confirm that everyone shown in this picture agreed to be published (consent), then try again.';

export interface PublicFileHandle {
  etag: string;
  version: number;
  contentType: string;
  /** Opens the file for sending. Not called when the browser already has the current copy. */
  open: () => Promise<{ stream: Readable; size: number }>;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly images: MediaImageService,
  ) {}

  // ------------------------------------------------------------------ upload

  async upload(admin: AuthenticatedUser, file: UploadedPicture | undefined, dto: UploadMediaDto, context: RequestContext) {
    if (!file) throw new BadRequestException('Choose a picture to upload.');
    if (CONSENT_FOLDERS.includes(dto.folder) && dto.consent !== true) {
      throw new BadRequestException(CONSENT_REQUIRED_MESSAGE);
    }

    const image = await this.images.process(file.buffer);
    const slug = slugify(dto.title);

    // Store the file first, then the database row; if the row cannot be saved, remove the file again.
    const key = await this.uniqueKey(dto.folder, slug, image.extension, this.prisma);
    await this.storage.put(key, image.buffer);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.cmsMediaAsset.create({
          data: {
            key,
            folder: dto.folder,
            title: dto.title,
            originalFilename: file.originalname.slice(0, 200),
            contentType: image.contentType,
            sizeBytes: image.sizeBytes,
            width: image.width,
            height: image.height,
            altText: dto.altText,
            consentRecordedAt: dto.consent === true ? new Date() : null,
            checksum: image.checksum,
            createdById: admin.id,
          },
          select: mediaDetailSelect,
        });
        await this.audit.record(
          {
            actorId: admin.id,
            action: 'media.uploaded',
            entityType: 'media',
            entityId: created.id,
            metadata: { key, folder: dto.folder, sizeBytes: image.sizeBytes },
            ipAddress: context.ipAddress,
          },
          tx,
        );
        return created;
      });
      return { media: toMediaDetail(row) };
    } catch (error) {
      await this.storage.delete(key);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Another picture just took that name. Please try again.');
      }
      throw error;
    }
  }

  // ----------------------------------------------------------------- replace

  /** Puts a new picture under the SAME key. The version goes up so browsers fetch the new one. */
  async replace(
    admin: AuthenticatedUser,
    id: string,
    file: UploadedPicture | undefined,
    dto: ReplaceMediaDto,
    context: RequestContext,
  ) {
    if (!file) throw new BadRequestException('Choose the new picture to upload.');

    const current = await this.prisma.cmsMediaAsset.findUnique({
      where: { id },
      select: { id: true, key: true, folder: true, version: true, width: true, height: true, sizeBytes: true },
    });
    if (!current) throw new NotFoundException('Picture not found.');
    if (CONSENT_FOLDERS.includes(current.folder) && dto.consent !== true) {
      throw new BadRequestException(CONSENT_REQUIRED_MESSAGE);
    }

    const image = await this.images.process(file.buffer);
    await this.storage.put(current.key, image.buffer); // same key, new bytes

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.cmsMediaAsset.update({
        where: { id },
        data: {
          contentType: image.contentType,
          sizeBytes: image.sizeBytes,
          width: image.width,
          height: image.height,
          checksum: image.checksum,
          originalFilename: file.originalname.slice(0, 200),
          version: { increment: 1 },
          ...(dto.altText ? { altText: dto.altText } : {}),
          ...(dto.consent === true ? { consentRecordedAt: new Date() } : {}),
        },
        select: mediaDetailSelect,
      });
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'media.replaced',
          entityType: 'media',
          entityId: id,
          metadata: { key: current.key },
          previousValue: { version: current.version, width: current.width, height: current.height, sizeBytes: current.sizeBytes },
          newValue: { version: updated.version, width: updated.width, height: updated.height, sizeBytes: updated.sizeBytes },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return updated;
    });
    return { media: toMediaDetail(row) };
  }

  // -------------------------------------------------------------- list / read

  async list(query: ListMediaQuery): Promise<Paginated<ReturnType<typeof toMediaView>>> {
    const where: Prisma.CmsMediaAssetWhereInput = {
      ...(query.folder ? { folder: query.folder } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { key: { contains: query.search.toLowerCase() } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.cmsMediaAsset.count({ where }),
      this.prisma.cmsMediaAsset.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: mediaListSelect,
      }),
    ]);
    return buildPage(rows.map(toMediaView), total, query);
  }

  async getOne(id: string) {
    const row = await this.prisma.cmsMediaAsset.findUnique({ where: { id }, select: mediaDetailSelect });
    if (!row) throw new NotFoundException('Picture not found.');
    return { media: toMediaDetail(row) };
  }

  // ------------------------------------------------------------------ update

  async update(admin: AuthenticatedUser, id: string, dto: UpdateMediaDto, context: RequestContext) {
    if (dto.title === undefined && dto.altText === undefined && dto.consent === undefined) {
      throw new BadRequestException('Nothing to update.');
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.cmsMediaAsset.findUnique({
        where: { id },
        select: { title: true, altText: true, folder: true, consentRecordedAt: true },
      });
      if (!current) throw new NotFoundException('Picture not found.');

      const data: Prisma.CmsMediaAssetUpdateInput = {};
      const changed: string[] = [];

      if (dto.title !== undefined && dto.title !== current.title) {
        data.title = dto.title;
        changed.push('title');
      }
      if (dto.altText !== undefined && dto.altText !== current.altText) {
        data.altText = dto.altText;
        changed.push('altText');
      }
      if (dto.consent === true && current.consentRecordedAt === null) {
        data.consentRecordedAt = new Date();
        changed.push('consent');
      }
      if (dto.consent === false && current.consentRecordedAt !== null) {
        if (CONSENT_FOLDERS.includes(current.folder)) {
          throw new BadRequestException('Pictures in this folder must keep their consent record.');
        }
        data.consentRecordedAt = null;
        changed.push('consent');
      }

      if (changed.length === 0) return tx.cmsMediaAsset.findUniqueOrThrow({ where: { id }, select: mediaDetailSelect });

      const updated = await tx.cmsMediaAsset.update({ where: { id }, data, select: mediaDetailSelect });
      await this.audit.record(
        { actorId: admin.id, action: 'media.updated', entityType: 'media', entityId: id, metadata: { changed }, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });
    return { media: toMediaDetail(row) };
  }

  // ------------------------------------------------------------------ delete

  /** Deletes a picture - only when nothing uses it. */
  async remove(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<void> {
    const key = await this.prisma.$transaction(async (tx) => {
      const asset = await tx.cmsMediaAsset.findUnique({
        where: { id },
        select: { key: true, usages: { select: { label: true }, orderBy: { label: 'asc' }, take: 5 }, _count: { select: { usages: true } } },
      });
      if (!asset) throw new NotFoundException('Picture not found.');

      const inUse = asset._count.usages;
      if (inUse > 0) {
        const where = [...new Set(asset.usages.map((usage) => usage.label))].join(', ');
        throw new ConflictException(
          `This picture is used in ${inUse} place${inUse === 1 ? '' : 's'} (${where}${inUse > asset.usages.length ? ', ...' : ''}). Replace it instead of deleting it.`,
        );
      }

      await tx.cmsMediaAsset.delete({ where: { id } });
      await this.audit.record(
        { actorId: admin.id, action: 'media.deleted', entityType: 'media', entityId: id, metadata: { key: asset.key }, ipAddress: context.ipAddress },
        tx,
      );
      return asset.key;
    });

    await this.storage.delete(key);
  }

  // ---------------------------------------------------------------- download

  /** The stored picture, for an admin to download. */
  async openForDownload(id: string) {
    const asset = await this.prisma.cmsMediaAsset.findUnique({
      where: { id },
      select: { key: true, contentType: true },
    });
    if (!asset) throw new NotFoundException('Picture not found.');

    const file = await this.storage.open(asset.key);
    if (!file) throw new NotFoundException('The picture file is missing from storage.');
    return { ...file, contentType: asset.contentType, filename: asset.key.split('/')[1] };
  }

  // ----------------------------------------------------------- public serving

  /**
   * Finds a picture for the PUBLIC website by folder and file name. Only pictures
   * registered in the media library are ever served, and a width may be asked for.
   */
  async findPublic(folder: string, file: string, requestedWidth?: number): Promise<PublicFileHandle | null> {
    const folderEnum = Object.values(CmsMediaFolder).find((value) => value.toLowerCase() === folder);
    if (!folderEnum || !/^[a-z0-9][a-z0-9_-]*\.[a-z0-9]{2,5}$/.test(file)) return null;

    const key = `${folder}/${file}`;
    const asset = await this.prisma.cmsMediaAsset.findUnique({
      where: { key },
      select: { key: true, contentType: true, version: true, width: true, checksum: true },
    });
    if (!asset) return null;

    // A smaller copy is only made when it is really smaller than the original.
    const width = requestedWidth ? snapWidth(requestedWidth) : undefined;
    const resized = width !== undefined && width < asset.width ? width : undefined;

    return {
      etag: `W/"${asset.checksum.slice(0, 16)}-${resized ?? 'original'}"`,
      version: asset.version,
      contentType: resized ? 'image/webp' : asset.contentType,
      open: async () => {
        if (!resized) {
          const original = await this.storage.open(asset.key);
          if (!original) throw new NotFoundException('Picture not found.');
          return original;
        }

        // The smaller copy is made once and remembered (its name includes the version).
        const variantKey = `cache/${folder}/${file.replace(/\.[a-z0-9]+$/, '')}-w${resized}-v${asset.version}.webp`;
        const cached = await this.storage.open(variantKey);
        if (cached) return cached;

        const original = await this.storage.read(asset.key);
        if (!original) throw new NotFoundException('Picture not found.');
        await this.storage.put(variantKey, await this.images.variant(original, resized));

        const created = await this.storage.open(variantKey);
        if (!created) throw new NotFoundException('Picture not found.');
        return created;
      },
    };
  }

  // ----------------------------------------------------------------- helpers

  private async uniqueKey(folder: CmsMediaFolder, slug: string, extension: string, db: DbClient): Promise<string> {
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const name = attempt === 1 ? slug : `${slug}-${attempt}`;
      const key = `${folder.toLowerCase()}/${name}.${extension}`;
      if (!(await db.cmsMediaAsset.findUnique({ where: { key }, select: { id: true } }))) return key;
    }
    throw new ConflictException('There are too many pictures with that name. Please choose a different title.');
  }
}