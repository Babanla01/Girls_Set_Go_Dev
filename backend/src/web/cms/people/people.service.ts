/**
 * people.service.ts
 * ---------------------------------------------------------------------------
 * Public profiles of the team and the instructors.
 *
 * Rules (from the website design):
 *  - A profile stays a DRAFT until it is complete: a title and a suitable photo
 *    (from the People folder, with its consent recorded, at least 480 × 480 px).
 *    The database itself refuses a published profile without a title and photo.
 *  - A PUBLISHED profile must keep being complete: to remove its photo or title,
 *    unpublish it first.
 *  - The photo is registered in the media library's "used on" list, so a photo in
 *    use can never be deleted by accident.
 *  - Only drafts can be deleted; a published profile is unpublished first.
 *  - Every change is audited with ids only (never names or bios).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CmsContentStatus, CmsMediaFolder, CmsPersonKind, Prisma } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../../../auth/auth.types';
import { AuditService } from '../../../common/audit/audit.service';
import { buildPage, Paginated, toSkipTake } from '../../../common/pagination/pagination';
import type { DbClient } from '../../../common/types/db-client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MediaUsageService } from '../media/media-usage.service';
import type { CreatePersonDto } from './dto/create-person.dto';
import type { ListPeopleQuery } from './dto/list-people.query';
import type { PublicPeopleQuery } from './dto/public-people.query';
import type { ReorderPeopleDto } from './dto/reorder-people.dto';
import type { UpdatePersonDto } from './dto/update-person.dto';
import { personProblems, personSelect, toPersonView, toPublicPerson } from './people.view';

const ENTITY = 'person';

@Injectable()
export class PeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly usage: MediaUsageService,
  ) {}

  // ------------------------------------------------------------------ create

  async create(admin: AuthenticatedUser, dto: CreatePersonDto, context: RequestContext) {
    const row = await this.prisma.$transaction(async (tx) => {
      if (dto.photoAssetId) await this.requirePersonPhoto(tx, dto.photoAssetId);

      const last = await tx.cmsPerson.aggregate({ _max: { displayOrder: true } });
      const created = await tx.cmsPerson.create({
        data: {
          fullName: dto.fullName,
          title: dto.title ?? '',
          subtitle: dto.subtitle ?? null,
          kind: dto.kind ?? CmsPersonKind.TEAM,
          bio: dto.bio ?? '',
          photoAssetId: dto.photoAssetId ?? null,
          showOnAbout: dto.showOnAbout ?? true,
          showOnCohort: dto.showOnCohort ?? false,
          displayOrder: (last._max.displayOrder ?? -1) + 1,
          createdById: admin.id,
        },
        select: personSelect,
      });

      await this.syncUsage(tx, created.id, created.fullName, created.photoAssetId);
      await this.audit.record(
        { actorId: admin.id, action: 'person.created', entityType: ENTITY, entityId: created.id, ipAddress: context.ipAddress },
        tx,
      );
      return created;
    });
    return { person: toPersonView(row) };
  }

  /**
   * Makes a DRAFT profile for an instructor account of the learning portal, if she has none.
   * The learning portal calls this when it creates an instructor, so the website team only has
   * to add a title and a photo. Safe to call again: it never makes a second profile.
   */
  async ensureForInstructor(
    instructor: { id: string; fullName: string },
    actorId: string | null,
    db: DbClient = this.prisma,
  ): Promise<{ id: string }> {
    const existing = await db.cmsPerson.findUnique({ where: { linkedInstructorId: instructor.id }, select: { id: true } });
    if (existing) return existing;

    const last = await db.cmsPerson.aggregate({ _max: { displayOrder: true } });
    const created = await db.cmsPerson.create({
      data: {
        fullName: instructor.fullName,
        kind: CmsPersonKind.INSTRUCTOR,
        showOnAbout: false,
        showOnCohort: true,
        linkedInstructorId: instructor.id,
        displayOrder: (last._max.displayOrder ?? -1) + 1,
        createdById: actorId,
      },
      select: { id: true },
    });
    await this.audit.record(
      { actorId, action: 'person.created', entityType: ENTITY, entityId: created.id, metadata: { fromInstructor: true } },
      db,
    );
    return created;
  }

  // -------------------------------------------------------------- list / read

  async list(query: ListPeopleQuery): Promise<Paginated<ReturnType<typeof toPersonView>>> {
    const where: Prisma.CmsPersonWhereInput = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { fullName: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.cmsPerson.count({ where }),
      this.prisma.cmsPerson.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { fullName: 'asc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: personSelect,
      }),
    ]);
    return buildPage(rows.map(toPersonView), total, query);
  }

  async getOne(id: string) {
    const row = await this.prisma.cmsPerson.findUnique({ where: { id }, select: personSelect });
    if (!row) throw new NotFoundException('Profile not found.');
    return { person: toPersonView(row) };
  }

  /** Published profiles for the public website, in display order. */
  async listPublic(query: PublicPeopleQuery) {
    const kinds =
      query.kind === 'TEAM'
        ? [CmsPersonKind.TEAM, CmsPersonKind.BOTH]
        : query.kind === 'INSTRUCTOR'
          ? [CmsPersonKind.INSTRUCTOR, CmsPersonKind.BOTH]
          : undefined;

    const rows = await this.prisma.cmsPerson.findMany({
      where: {
        status: CmsContentStatus.PUBLISHED,
        ...(kinds ? { kind: { in: kinds } } : {}),
        ...(query.placement === 'about' ? { showOnAbout: true } : {}),
        ...(query.placement === 'cohort' ? { showOnCohort: true } : {}),
      },
      orderBy: [{ displayOrder: 'asc' }, { fullName: 'asc' }, { id: 'asc' }],
      select: personSelect,
    });
    return { people: rows.map(toPublicPerson) };
  }

  // ------------------------------------------------------------------ update

  async update(admin: AuthenticatedUser, id: string, dto: UpdatePersonDto, context: RequestContext) {
    if (Object.values(dto).every((value) => value === undefined)) throw new BadRequestException('Nothing to update.');

    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.cmsPerson.findUnique({ where: { id }, select: personSelect });
      if (!current) throw new NotFoundException('Profile not found.');

      const data: Prisma.CmsPersonUncheckedUpdateInput = {};
      const changed: string[] = [];
      const set = (field: string, value: unknown, name: string = field) => {
        (data as Record<string, unknown>)[field] = value;
        changed.push(name);
      };

      if (dto.fullName !== undefined && dto.fullName !== current.fullName) set('fullName', dto.fullName);
      if (dto.title !== undefined && dto.title !== current.title) set('title', dto.title);
      if (dto.subtitle !== undefined && (dto.subtitle || null) !== current.subtitle) set('subtitle', dto.subtitle || null);
      if (dto.kind !== undefined && dto.kind !== current.kind) set('kind', dto.kind);
      if (dto.bio !== undefined && dto.bio !== current.bio) set('bio', dto.bio);
      if (dto.showOnAbout !== undefined && dto.showOnAbout !== current.showOnAbout) set('showOnAbout', dto.showOnAbout);
      if (dto.showOnCohort !== undefined && dto.showOnCohort !== current.showOnCohort) set('showOnCohort', dto.showOnCohort);

      const nextPhotoId = dto.photoAssetId === undefined ? current.photoAssetId : dto.photoAssetId;
      if (nextPhotoId !== current.photoAssetId) {
        if (nextPhotoId) await this.requirePersonPhoto(tx, nextPhotoId);
        set('photoAssetId', nextPhotoId, 'photo');
      }

      if (changed.length === 0) return current;

      // A published profile must stay complete.
      if (current.status === CmsContentStatus.PUBLISHED) {
        const photo = nextPhotoId ? await this.loadPhotoFacts(tx, nextPhotoId) : null;
        const problems = personProblems({ title: dto.title ?? current.title, photo });
        if (problems.length > 0) {
          throw new BadRequestException([...problems, 'To remove these, unpublish the profile first.']);
        }
      }

      const updated = await tx.cmsPerson.update({ where: { id }, data, select: personSelect });
      await this.syncUsage(tx, id, updated.fullName, updated.photoAssetId);
      await this.audit.record(
        { actorId: admin.id, action: 'person.updated', entityType: ENTITY, entityId: id, metadata: { changed }, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });
    return { person: toPersonView(row) };
  }

  // -------------------------------------------------------- publish / unpublish

  async publish(admin: AuthenticatedUser, id: string, context: RequestContext) {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.cmsPerson.findUnique({ where: { id }, select: personSelect });
      if (!current) throw new NotFoundException('Profile not found.');
      if (current.status === CmsContentStatus.PUBLISHED) throw new ConflictException('This profile is already published.');

      const problems = personProblems({ title: current.title, photo: current.photo });
      if (problems.length > 0) throw new BadRequestException(['This profile is not ready to publish yet.', ...problems]);

      const updated = await tx.cmsPerson.update({
        where: { id },
        data: { status: CmsContentStatus.PUBLISHED, publishedAt: new Date() },
        select: personSelect,
      });
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'person.published',
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
    return { person: toPersonView(row) };
  }

  async unpublish(admin: AuthenticatedUser, id: string, context: RequestContext) {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.cmsPerson.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw new NotFoundException('Profile not found.');
      if (current.status !== CmsContentStatus.PUBLISHED) throw new ConflictException('This profile is not published.');

      const updated = await tx.cmsPerson.update({
        where: { id },
        data: { status: CmsContentStatus.DRAFT, publishedAt: null },
        select: personSelect,
      });
      await this.audit.record(
        {
          actorId: admin.id,
          action: 'person.unpublished',
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
    return { person: toPersonView(row) };
  }

  // ----------------------------------------------------------- reorder / delete

  /** Puts the profiles in the given order (the first id is shown first). */
  async reorder(admin: AuthenticatedUser, dto: ReorderPeopleDto, context: RequestContext) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.cmsPerson.count({ where: { id: { in: dto.ids } } });
      if (found !== dto.ids.length) throw new NotFoundException('One of the profiles was not found.');

      for (const [index, id] of dto.ids.entries()) {
        await tx.cmsPerson.update({ where: { id }, data: { displayOrder: index } });
      }
      await this.audit.record(
        { actorId: admin.id, action: 'person.reordered', entityType: ENTITY, metadata: { count: dto.ids.length }, ipAddress: context.ipAddress },
        tx,
      );
    });

    // Return everyone in the new order, so the screen can redraw straight away.
    const rows = await this.prisma.cmsPerson.findMany({
      orderBy: [{ displayOrder: 'asc' }, { fullName: 'asc' }, { id: 'asc' }],
      select: personSelect,
    });
    return { people: rows.map(toPersonView) };
  }

  /** Deletes a DRAFT profile. A published one must be unpublished first. */
  async remove(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.cmsPerson.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw new NotFoundException('Profile not found.');
      if (current.status === CmsContentStatus.PUBLISHED) {
        throw new ConflictException('Unpublish this profile before deleting it.');
      }

      await this.usage.removeFor(ENTITY, id, tx);
      await tx.cmsPerson.delete({ where: { id } });
      await this.audit.record(
        { actorId: admin.id, action: 'person.deleted', entityType: ENTITY, entityId: id, ipAddress: context.ipAddress },
        tx,
      );
    });
  }

  // ----------------------------------------------------------------- helpers

  /** The photo must exist and come from the People folder. */
  private async requirePersonPhoto(db: DbClient, assetId: string): Promise<void> {
    const assets = await this.usage.requireAssets([assetId], db);
    if (assets.get(assetId)?.folder !== CmsMediaFolder.PEOPLE) {
      throw new BadRequestException('Choose a picture from the People folder of the media library.');
    }
  }

  private loadPhotoFacts(db: DbClient, assetId: string) {
    return db.cmsMediaAsset.findUnique({
      where: { id: assetId },
      select: { folder: true, consentRecordedAt: true, width: true, height: true },
    });
  }

  private syncUsage(db: DbClient, personId: string, fullName: string, photoAssetId: string | null) {
    return this.usage.replaceFor(ENTITY, personId, `Person: ${fullName}`, [{ field: 'photo', assetId: photoAssetId }], db);
  }
}