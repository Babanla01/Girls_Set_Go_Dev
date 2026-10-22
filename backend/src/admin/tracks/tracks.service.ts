/**
 * tracks.service.ts
 * ---------------------------------------------------------------------------
 * The rules for how admins manage tracks (programme areas).
 *
 *  - Nothing is deleted: tracks are ARCHIVED, so history stays intact.
 *  - A track cannot be archived while it still has active courses.
 *  - Every change is written to the audit log in the same transaction.
 *  - Names are unique ignoring capitals (the database enforces it too).
 */
import { ConflictException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, TrackStatus } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { buildPage, Paginated, toSkipTake } from '../../common/pagination/pagination';
import type { DbClient } from '../../common/types/db-client';
import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { cleanLabel, labelKey } from '../../catalog/catalog.util';
import { lockTrack } from '../../catalog/row-lock';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateTrackDto } from './dto/create-track.dto';
import type { ListTracksQuery } from './dto/list-tracks.query';
import type { UpdateTrackDto } from './dto/update-track.dto';
import { toTrackView, trackSelect, TrackView } from './track.view';

@Injectable()
export class TracksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(admin: AuthenticatedUser, dto: CreateTrackDto, context: RequestContext): Promise<{ track: TrackView }> {
    const name = cleanLabel(dto.name);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.track.create({
          data: {
            name,
            nameKey: labelKey(name),
            description: dto.description?.trim() || null,
            createdById: admin.id,
          },
          select: trackSelect,
        });
        await this.audit.record(
          { actorId: admin.id, action: 'track.created', entityType: 'track', entityId: created.id, metadata: { name }, ipAddress: context.ipAddress },
          tx,
        );
        return created;
      });
      return { track: toTrackView(row) };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async list(query: ListTracksQuery): Promise<Paginated<TrackView>> {
    const where: Prisma.TrackWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.track.count({ where }),
      this.prisma.track.findMany({
        where,
        orderBy: [{ [query.sortBy]: query.sortDir }, { id: 'asc' }],
        ...toSkipTake(query),
        select: trackSelect,
      }),
    ]);

    return buildPage(rows.map(toTrackView), total, query);
  }

  async getOne(id: string): Promise<{ track: TrackView }> {
    const row = await this.prisma.track.findUnique({ where: { id }, select: trackSelect });
    if (!row) throw new NotFoundException('Track not found.');
    return { track: toTrackView(row) };
  }

  async update(
    admin: AuthenticatedUser,
    id: string,
    dto: UpdateTrackDto,
    context: RequestContext,
  ): Promise<{ track: TrackView }> {
    if (dto.name === undefined && dto.description === undefined) {
      throw new BadRequestException('Nothing to update. Provide a name or a description.');
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const current = await tx.track.findUnique({ where: { id }, select: { name: true, description: true } });
        if (!current) throw new NotFoundException('Track not found.');

        const data: Prisma.TrackUpdateInput = {};
        const changed: string[] = [];

        if (dto.name !== undefined && cleanLabel(dto.name) !== current.name) {
          data.name = cleanLabel(dto.name);
          data.nameKey = labelKey(dto.name);
          changed.push('name');
        }
        if (dto.description !== undefined && (dto.description.trim() || null) !== current.description) {
          data.description = dto.description.trim() || null;
          changed.push('description');
        }

        if (changed.length === 0) return tx.track.findUniqueOrThrow({ where: { id }, select: trackSelect });

        const updated = await tx.track.update({ where: { id }, data, select: trackSelect });
        await this.audit.record(
          { actorId: admin.id, action: 'track.updated', entityType: 'track', entityId: id, metadata: { changed }, ipAddress: context.ipAddress },
          tx,
        );
        return updated;
      });
      return { track: toTrackView(row) };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  /** Archiving is refused while the track still has courses in use. */
  async archive(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ track: TrackView }> {
    const row = await this.prisma.$transaction(async (tx) => {
      await lockTrack(tx, id); // take turns with anyone adding a course right now
      const current = await this.findOrThrow(tx, id);

      if (current.status === TrackStatus.ARCHIVED) throw new ConflictException('This track is already archived.');

      const active = await tx.course.count({ where: { trackId: id, status: { not: 'ARCHIVED' } } });
      if (active > 0) {
        throw new ConflictException(
          `This track still has ${active} active course${active === 1 ? '' : 's'}. Archive ${active === 1 ? 'it' : 'them'} first.`,
        );
      }

      const updated = await tx.track.update({ where: { id }, data: { status: TrackStatus.ARCHIVED }, select: trackSelect });
      await this.audit.record(
        { actorId: admin.id, action: 'track.archived', entityType: 'track', entityId: id, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });
    return { track: toTrackView(row) };
  }

  async restore(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ track: TrackView }> {
    const row = await this.prisma.$transaction(async (tx) => {
      await lockTrack(tx, id);
      const current = await this.findOrThrow(tx, id);

      if (current.status !== TrackStatus.ARCHIVED) throw new ConflictException('This track is not archived.');

      const updated = await tx.track.update({ where: { id }, data: { status: TrackStatus.ACTIVE }, select: trackSelect });
      await this.audit.record(
        { actorId: admin.id, action: 'track.restored', entityType: 'track', entityId: id, ipAddress: context.ipAddress },
        tx,
      );
      return updated;
    });
    return { track: toTrackView(row) };
  }

  // ----------------------------------------------------------------- helpers

  private async findOrThrow(db: DbClient, id: string) {
    const row = await db.track.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!row) throw new NotFoundException('Track not found.');
    return row;
  }

  /** "That name is taken" (a database rule) becomes a friendly 409. Other errors pass through. */
  private translateDatabaseError(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException('A track with that name already exists.');
    }
    return error;
  }
}