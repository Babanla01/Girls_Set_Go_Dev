/**
 * announcements.service.ts
 * ---------------------------------------------------------------------------
 * Short updates from the learning team to a group of students.
 *
 *  - WHO WRITES: admins (all cohorts, a track or a cohort) and instructors (only
 *    cohorts they teach). Students only read. No replies, comments or reactions.
 *  - LIFE CYCLE: a DRAFT is written; PUBLISH makes it visible to its audience and puts
 *    a "New announcement" in each student's notification bell (once per student, even
 *    if it is unpublished and published again). UNPUBLISH hides it again. Only drafts
 *    can be deleted.
 *  - EDITING: the title and text can be changed any time; a published announcement then
 *    shows "Edited ..." to students and the change is audited. The audience is locked
 *    once published (people were already told).
 *  - A student sees announcements for the cohort and track she is in now, and the
 *    ones for all cohorts, newest first.
 *  - Announcements are NOT emailed (in-app only for now).
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AnnAudienceType, AnnStatus, Prisma, Role } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { AuditService } from '../../common/audit/audit.service';
import { buildPage, toSkipTake } from '../../common/pagination/pagination';
import type { DbClient } from '../../common/types/db-client';
import { NotificationsService } from '../../platform/notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AudienceInput, AudienceService } from './audience.service';
import { AnnouncementRow, announcementSelect, toAnnouncementView, toStudentCard } from './announcements.view';
import type { AudiencePreviewQuery } from './dto/audience-preview.query';
import type { CreateAnnouncementDto } from './dto/create-announcement.dto';
import type { ListAnnouncementsQuery } from './dto/list-announcements.query';
import type { UpdateAnnouncementDto } from './dto/update-announcement.dto';

const ENTITY = 'announcement';
const HTML_START = /<\s*[a-zA-Z/!?]/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/; // tabs and new lines are fine

/** A plain-English problem with the text of an announcement, or null when it is fine. */
function textProblem(title: string, message: string): string | null {
  if (CONTROL_CHARS.test(title) || CONTROL_CHARS.test(message)) return 'The text contains hidden control characters. Please retype it.';
  if (HTML_START.test(title) || HTML_START.test(message)) return 'Announcements are plain text: please remove anything that looks like HTML.';
  if (/[\r\n]/.test(title)) return 'The title must be a single line.';
  return null;
}

const audienceOf = (row: Pick<AnnouncementRow, 'audienceType' | 'trackId' | 'cohortId'>): AudienceInput => ({
  audienceType: row.audienceType,
  trackId: row.trackId,
  cohortId: row.cohortId,
});

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly audience: AudienceService,
    private readonly notifications: NotificationsService,
  ) {}

  // --------------------------------------------------------------- compose form

  options(user: AuthenticatedUser) {
    return this.audience.options(user);
  }

  /** "This will reach N learners" (counts only; no names). */
  async preview(user: AuthenticatedUser, query: AudiencePreviewQuery) {
    const audience: AudienceInput = { audienceType: query.audienceType, trackId: query.trackId ?? null, cohortId: query.cohortId ?? null };
    await this.audience.assertAllowed(user, audience);

    const label = (await this.audience.labels([audience]))(audience);
    return { audience: { ...audience, label }, recipientCount: (await this.audience.recipientIds(audience)).length };
  }

  // ------------------------------------------------------------------- create

  async create(user: AuthenticatedUser, dto: CreateAnnouncementDto, context: RequestContext) {
    const problem = textProblem(dto.title, dto.message);
    if (problem) throw new BadRequestException(problem);

    const audience: AudienceInput = { audienceType: dto.audienceType, trackId: dto.trackId ?? null, cohortId: dto.cohortId ?? null };
    await this.audience.assertAllowed(user, audience);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.annAnnouncement.create({
        data: { title: dto.title, message: dto.message, ...audience, authorId: user.id, authorRole: user.role },
        select: announcementSelect,
      });
      await this.audit.record(
        { actorId: user.id, action: 'announcement.created', entityType: ENTITY, entityId: created.id, metadata: { audience: dto.audienceType }, ipAddress: context.ipAddress },
        tx,
      );
      return created;
    });
    return { announcement: await this.view(user, row) };
  }

  /**
   * For the learning portal: creates an announcement and publishes it straight away (for example
   * "This course was updated" when a course change is published). Returns its id.
   */
  async publishSystemAnnouncement(input: { title: string; message: string; cohortId: string; authorId: string; authorRole: Role }, db?: DbClient): Promise<{ id: string }> {
    const problem = textProblem(input.title, input.message);
    if (problem) throw new BadRequestException(problem);

    const run = async (tx: DbClient) => {
      const audience: AudienceInput = { audienceType: AnnAudienceType.COHORT, trackId: null, cohortId: input.cohortId };
      const created = await tx.annAnnouncement.create({
        data: { title: input.title, message: input.message, ...audience, authorId: input.authorId, authorRole: input.authorRole, status: AnnStatus.PUBLISHED, publishedAt: new Date() },
        select: { id: true },
      });
      const recipients = await this.audience.recipientIds(audience);
      await this.notifications.notifyMany(recipients, 'announcement.new', { announcementId: created.id, title: input.title }, { db: tx, dedupeKey: `announcement:${created.id}` });
      await this.audit.record(
        { actorId: input.authorId, action: 'announcement.published', entityType: ENTITY, entityId: created.id, metadata: { audience: 'COHORT', recipients: recipients.length, system: true } },
        tx,
      );
      return created;
    };
    return db ? run(db) : this.prisma.$transaction(run);
  }

  // ------------------------------------------------------------- list / detail

  async list(user: AuthenticatedUser, query: ListAnnouncementsQuery) {
    const visible = await this.visibleTo(user);
    const where: Prisma.AnnAnnouncementWhereInput = {
      AND: [
        visible,
        ...(query.status ? [{ status: query.status }] : []),
        ...(query.audienceType ? [{ audienceType: query.audienceType }] : []),
        ...(query.mine ? [{ authorId: user.id }] : []),
        ...(query.search ? [{ title: { contains: query.search, mode: 'insensitive' as const } }] : []),
      ],
    };

    const [total, rows] = await Promise.all([
      this.prisma.annAnnouncement.count({ where }),
      this.prisma.annAnnouncement.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: announcementSelect,
      }),
    ]);

    const label = await this.audience.labels(rows.map(audienceOf));
    return buildPage(rows.map((row) => toAnnouncementView(row, label(row), { canEdit: this.canManage(user, row) })), total, query);
  }

  async getOne(user: AuthenticatedUser, id: string) {
    const row = await this.findVisible(user, id);
    const recipientCount = row.status === AnnStatus.PUBLISHED ? undefined : (await this.audience.recipientIds(audienceOf(row))).length;
    return { announcement: await this.view(user, row, recipientCount) };
  }

  // ------------------------------------------------------------------- update

  async update(user: AuthenticatedUser, id: string, dto: UpdateAnnouncementDto, context: RequestContext) {
    if (Object.values(dto).every((value) => value === undefined)) throw new BadRequestException('Nothing to update.');

    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const current = await tx.annAnnouncement.findUniqueOrThrow({ where: { id }, select: announcementSelect });
      await this.assertAccess(user, current);

      const data: Prisma.AnnAnnouncementUncheckedUpdateInput = {};
      const changed: string[] = [];

      const title = dto.title ?? current.title;
      const message = dto.message ?? current.message;
      if (dto.title !== undefined || dto.message !== undefined) {
        const problem = textProblem(title, message);
        if (problem) throw new BadRequestException(problem);
        if (title !== current.title) { data.title = title; changed.push('title'); }
        if (message !== current.message) { data.message = message; changed.push('message'); }
      }

      const changesAudience = dto.audienceType !== undefined || dto.trackId !== undefined || dto.cohortId !== undefined;
      if (changesAudience) {
        if (current.status === AnnStatus.PUBLISHED) {
          throw new ConflictException('The audience of a published announcement cannot change (people were already told). Unpublish it first.');
        }
        const next: AudienceInput = {
          audienceType: dto.audienceType ?? current.audienceType,
          // Changing the type clears the ids that no longer apply.
          trackId: dto.audienceType !== undefined ? (dto.trackId ?? null) : (dto.trackId ?? current.trackId),
          cohortId: dto.audienceType !== undefined ? (dto.cohortId ?? null) : (dto.cohortId ?? current.cohortId),
        };
        await this.audience.assertAllowed({ id: current.authorId, role: current.authorRole }, next);
        if (next.audienceType !== current.audienceType || next.trackId !== current.trackId || next.cohortId !== current.cohortId) {
          Object.assign(data, next);
          changed.push('audience');
        }
      }

      if (changed.length === 0) return current;
      if (current.status === AnnStatus.PUBLISHED) data.editedAt = new Date(); // students see "Edited ..."

      const updated = await tx.annAnnouncement.update({ where: { id }, data, select: announcementSelect });
      await this.audit.record(
        {
          actorId: user.id,
          action: current.status === AnnStatus.PUBLISHED ? 'announcement.edited' : 'announcement.updated',
          entityType: ENTITY,
          entityId: id,
          metadata: { changed },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return updated;
    });
    return { announcement: await this.view(user, row) };
  }

  // -------------------------------------------------------- publish / unpublish

  async publish(user: AuthenticatedUser, id: string, context: RequestContext) {
    const { row, recipients } = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const current = await tx.annAnnouncement.findUniqueOrThrow({ where: { id }, select: announcementSelect });
      await this.assertAccess(user, current);
      if (current.status === AnnStatus.PUBLISHED) throw new ConflictException('This announcement is already published.');

      // The audience may have changed since it was written (a cohort finished, she stopped teaching it).
      const audience = audienceOf(current);
      await this.audience.assertAllowed({ id: current.authorId, role: current.authorRole }, audience);
      const recipientIds = await this.audience.recipientIds(audience);

      const updated = await tx.annAnnouncement.update({
        where: { id },
        data: { status: AnnStatus.PUBLISHED, publishedAt: new Date(), editedAt: null },
        select: announcementSelect,
      });
      await this.notifications.notifyMany(recipientIds, 'announcement.new', { announcementId: id, title: current.title }, { db: tx, dedupeKey: `announcement:${id}` });
      await this.audit.record(
        {
          actorId: user.id,
          action: 'announcement.published',
          entityType: ENTITY,
          entityId: id,
          metadata: { audience: current.audienceType, recipients: recipientIds.length },
          previousValue: { status: AnnStatus.DRAFT },
          newValue: { status: AnnStatus.PUBLISHED },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { row: updated, recipients: recipientIds.length };
    });
    return { announcement: await this.view(user, row, recipients) };
  }

  async unpublish(user: AuthenticatedUser, id: string, context: RequestContext) {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const current = await tx.annAnnouncement.findUniqueOrThrow({ where: { id }, select: announcementSelect });
      await this.assertAccess(user, current);
      if (current.status !== AnnStatus.PUBLISHED) throw new ConflictException('This announcement is not published.');

      const updated = await tx.annAnnouncement.update({
        where: { id },
        data: { status: AnnStatus.DRAFT, publishedAt: null, editedAt: null },
        select: announcementSelect,
      });
      await this.audit.record(
        {
          actorId: user.id,
          action: 'announcement.unpublished',
          entityType: ENTITY,
          entityId: id,
          previousValue: { status: AnnStatus.PUBLISHED },
          newValue: { status: AnnStatus.DRAFT },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return updated;
    });
    return { announcement: await this.view(user, row) };
  }

  /** Deletes a DRAFT. A published announcement must be unpublished first. */
  async remove(user: AuthenticatedUser, id: string, context: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const current = await tx.annAnnouncement.findUniqueOrThrow({ where: { id }, select: announcementSelect });
      await this.assertAccess(user, current);
      if (current.status === AnnStatus.PUBLISHED) throw new ConflictException('Unpublish this announcement before deleting it.');

      await tx.annAnnouncement.delete({ where: { id } });
      await this.audit.record({ actorId: user.id, action: 'announcement.deleted', entityType: ENTITY, entityId: id, ipAddress: context.ipAddress }, tx);
    });
  }

  // ----------------------------------------------------------------- students

  /** The announcements a student can read: for her cohort, her track, and all cohorts. Newest first. */
  async listForStudent(user: AuthenticatedUser, query: { page?: number; pageSize?: number }) {
    const scope = await this.audience.studentScope(user.id);
    const paging = { page: query.page ?? 1, pageSize: query.pageSize ?? 20 };

    if (scope.cohortIds.length === 0) {
      return { ...buildPage([], 0, paging as never), heading: null };
    }

    const where: Prisma.AnnAnnouncementWhereInput = {
      status: AnnStatus.PUBLISHED,
      OR: [
        { audienceType: AnnAudienceType.ALL_COHORTS },
        { audienceType: AnnAudienceType.COHORT, cohortId: { in: scope.cohortIds } },
        { audienceType: AnnAudienceType.TRACK, trackId: { in: scope.trackIds } },
      ],
    };
    const [total, rows] = await Promise.all([
      this.prisma.annAnnouncement.count({ where }),
      this.prisma.annAnnouncement.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
        ...toSkipTake(paging as never),
        select: announcementSelect,
      }),
    ]);

    const label = await this.audience.labels(rows.map(audienceOf));
    const group = scope.groups[0];
    return {
      ...buildPage(rows.map((row) => toStudentCard(row, label(row))), total, paging as never),
      heading: group ? `Updates for ${group.courseTitle} · ${group.cohortName}` : null,
    };
  }

  // ----------------------------------------------------------------- helpers

  /** Which announcements this person may see in the staff screens. */
  private async visibleTo(user: AuthenticatedUser): Promise<Prisma.AnnAnnouncementWhereInput> {
    if (user.role === Role.ADMIN) return {};
    const cohortIds = await this.audience.cohortIdsTaughtBy(user.id);
    return {
      OR: [
        { authorId: user.id },
        { status: AnnStatus.PUBLISHED, audienceType: AnnAudienceType.COHORT, cohortId: { in: cohortIds } },
      ],
    };
  }

  private async findVisible(user: AuthenticatedUser, id: string): Promise<AnnouncementRow> {
    const row = await this.prisma.annAnnouncement.findFirst({ where: { id, AND: [await this.visibleTo(user)] }, select: announcementSelect });
    if (!row) throw new NotFoundException('Announcement not found.');
    return row;
  }

  /** An admin can change any announcement; an instructor only her own. */
  private canManage(user: AuthenticatedUser, row: Pick<AnnouncementRow, 'authorId'>): boolean {
    return user.role === Role.ADMIN || row.authorId === user.id;
  }

  /**
   * Before changing an announcement: if this person cannot even SEE it, it "does not exist" for her
   * (404, so nobody learns what other people wrote); if she can see it but it is not hers to change, 403.
   */
  private async assertAccess(user: AuthenticatedUser, row: Pick<AnnouncementRow, 'authorId' | 'status' | 'audienceType' | 'cohortId'>): Promise<void> {
    if (user.role !== Role.ADMIN) {
      const taught = row.audienceType === AnnAudienceType.COHORT && row.status === AnnStatus.PUBLISHED && row.cohortId !== null
        ? (await this.audience.cohortIdsTaughtBy(user.id)).includes(row.cohortId)
        : false;
      if (row.authorId !== user.id && !taught) throw new NotFoundException('Announcement not found.');
    }
    if (!this.canManage(user, row)) throw new ForbiddenException('You can only change announcements you wrote.');
  }

  private async view(user: AuthenticatedUser, row: AnnouncementRow, recipientCount?: number) {
    const label = await this.audience.labels([audienceOf(row)]);
    return toAnnouncementView(row, label(audienceOf(row)), { recipientCount, canEdit: this.canManage(user, row) });
  }

  /** Takes turns with anyone else changing this announcement; 404 if it does not exist. */
  private async lock(tx: DbClient, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "ann_announcements" WHERE id = ${id}::uuid FOR UPDATE`);
    if (rows.length === 0) throw new NotFoundException('Announcement not found.');
  }
}