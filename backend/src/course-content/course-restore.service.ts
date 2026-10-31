/**
 * course-restore.service.ts
 * ---------------------------------------------------------------------------
 * Going back: RESTORE an older version, or DISCARD the draft changes.
 *
 *  RESTORE (version N)
 *    Makes the contents of version N live again, as a NEW version (so history is
 *    never rewritten) whose source is RESTORE and which remembers N. The draft is
 *    replaced by the same contents, so draft and live match afterwards.
 *    Refused when:
 *      - N is already the live version, or has the same contents as the live one;
 *      - the draft has unpublished changes, unless the person confirms with
 *        "discardDraftChanges" that those changes may be thrown away.
 *
 *  DISCARD DRAFT
 *    Throws away the unpublished changes and puts the live version back into the
 *    draft. No new version is made (nothing was published).
 *
 * Every item keeps its permanent id when it is put back, so anything that points at
 * a lesson (such as a student's progress) keeps pointing at the same lesson.
 *
 * Who may do this: the same people who may edit and publish (admins, and the
 * instructor assigned to that cohort).
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VersionSource } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import type { DbClient } from '../common/types/db-client';
import { PrismaService } from '../prisma/prisma.service';
import { ContentEditor } from './content-editor.service';
import type { DiscardDraftDto } from './dto/discard-draft.dto';
import type { RestoreDto } from './dto/restore.dto';
import { countSnapshot, EMPTY_SNAPSHOT, loadDraft, parseSnapshot, Snapshot } from './snapshot';
import { diffSnapshots, toBrief } from './snapshot-diff';
import { clearDraft, writeSnapshot } from './write-snapshot';

/** The largest version number the database can hold (anything bigger cannot exist). */
const MAX_VERSION_NUMBER = 2_147_483_647;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

@Injectable()
export class CourseRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly editor: ContentEditor,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- restore

  async restore(user: AuthenticatedUser, contentId: string, number: number, dto: RestoreDto, context: RequestContext) {
    if (number < 1 || number > MAX_VERSION_NUMBER) throw new NotFoundException(`Version ${number} not found.`);

    return this.editor.run(user, contentId, async (tx, content) => {
      const target = await tx.courseVersion.findUnique({
        where: { contentId_number: { contentId, number } },
        select: { snapshot: true },
      });
      if (!target) throw new NotFoundException(`Version ${number} not found.`);
      if (content.publishedVersion === number) throw new ConflictException(`Version ${number} is already the live version.`);

      const targetSnapshot = parseSnapshot(target.snapshot);
      const live = await this.liveSnapshot(tx, contentId, content.publishedVersion);

      // Restoring replaces the draft, so unpublished work must be confirmed away first.
      const draft = await loadDraft(tx, contentId);
      const unpublished = diffSnapshots(live, draft.snapshot).length;
      if (unpublished > 0 && !dto.discardDraftChanges) {
        throw new ConflictException(
          `The draft has ${plural(unpublished, 'unpublished change')}. Publish or discard them first, or confirm that restoring may replace them.`,
        );
      }

      const changes = diffSnapshots(live, targetSnapshot);
      if (changes.length === 0) {
        throw new ConflictException(`Version ${number} has the same contents as the live version, so there is nothing to restore.`);
      }

      // Put the old contents into the draft, then record them as the new live version.
      const draftRevision = await this.resetDraft(tx, contentId, targetSnapshot, user.id);

      const latest = await tx.courseVersion.aggregate({ where: { contentId }, _max: { number: true } });
      const newNumber = (latest._max.number ?? 0) + 1;
      const counts = countSnapshot(targetSnapshot);
      const summary = dto.summary ?? `Restored version ${number}`;

      const created = await tx.courseVersion.create({
        data: {
          contentId,
          number: newNumber,
          source: VersionSource.RESTORE,
          summary,
          snapshot: target.snapshot as unknown as Prisma.InputJsonObject,
          changes: changes.map(toBrief) as unknown as Prisma.InputJsonArray,
          weekCount: counts.weeks,
          lessonCount: counts.lessons,
          blockCount: counts.blocks,
          publishedById: user.id,
          publishedByRole: user.role,
          restoredFromNumber: number,
        },
        select: { createdAt: true },
      });

      await tx.courseContent.update({
        where: { id: contentId },
        data: { publishedVersion: newNumber, publishedAt: created.createdAt, publishedDraftRevision: draftRevision },
      });

      await this.audit.record(
        {
          actorId: user.id,
          action: 'course_content.restored',
          entityType: 'course_content',
          entityId: contentId,
          metadata: { restoredFrom: number, newVersion: newNumber, replacedDraftChanges: unpublished, cohortId: content.cohortId },
          previousValue: { liveVersion: content.publishedVersion },
          newValue: { liveVersion: newNumber },
          ipAddress: context.ipAddress,
        },
        tx,
      );

      return {
        version: {
          number: newNumber,
          source: VersionSource.RESTORE,
          summary,
          changeCount: changes.length,
          counts,
          publishedAt: created.createdAt,
          publishedBy: { id: user.id, fullName: user.fullName, role: user.role },
          restoredFromNumber: number,
          isLive: true,
        },
        replacedDraftChanges: unpublished,
        draftRevision,
      };
    });
  }

  // ------------------------------------------------------------ discard draft

  async discardDraft(user: AuthenticatedUser, contentId: string, dto: DiscardDraftDto, context: RequestContext) {
    return this.editor.run(user, contentId, async (tx, content) => {
      if (content.publishedVersion === null) {
        throw new ConflictException('Nothing has been published yet, so there is no live version to go back to.');
      }
      if (dto.expectedDraftRevision !== undefined && dto.expectedDraftRevision !== content.draftRevision) {
        throw new ConflictException('The draft changed after you reviewed it. Review the changes again before discarding them.');
      }

      const live = await this.liveSnapshot(tx, contentId, content.publishedVersion);
      const draft = await loadDraft(tx, contentId);
      const discarded = diffSnapshots(live, draft.snapshot).length;
      if (discarded === 0) throw new ConflictException('There are no draft changes to discard.');

      const draftRevision = await this.resetDraft(tx, contentId, live, user.id);
      await tx.courseContent.update({ where: { id: contentId }, data: { publishedDraftRevision: draftRevision } });

      await this.audit.record(
        {
          actorId: user.id,
          action: 'course_content.draft_discarded',
          entityType: 'course_content',
          entityId: contentId,
          metadata: { discardedChanges: discarded, liveVersion: content.publishedVersion, cohortId: content.cohortId },
          ipAddress: context.ipAddress,
        },
        tx,
      );

      return { discardedChanges: discarded, liveVersion: content.publishedVersion, draftRevision };
    });
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Replaces the whole draft with a snapshot (same ids), and raises the draft
   * revision so every open editor knows to reload. Returns the new draft revision.
   */
  private async resetDraft(tx: DbClient, contentId: string, snapshot: Snapshot, userId: string): Promise<number> {
    await clearDraft(tx, contentId);
    await writeSnapshot(tx, contentId, snapshot, { freshIds: false });

    const saved = await tx.courseContent.update({
      where: { id: contentId },
      data: { draftRevision: { increment: 1 }, lastEditedById: userId, lastEditedAt: new Date() },
      select: { draftRevision: true },
    });
    return saved.draftRevision;
  }

  private async liveSnapshot(tx: DbClient, contentId: string, publishedVersion: number | null): Promise<Snapshot> {
    if (publishedVersion === null) return EMPTY_SNAPSHOT;
    const row = await tx.courseVersion.findUnique({
      where: { contentId_number: { contentId, number: publishedVersion } },
      select: { snapshot: true },
    });
    if (!row) throw new NotFoundException(`The live version (${publishedVersion}) could not be found.`);
    return parseSnapshot(row.snapshot);
  }
}
