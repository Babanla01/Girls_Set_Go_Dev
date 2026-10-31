/**
 * course-versions.service.ts
 * ---------------------------------------------------------------------------
 * Publishing a course copy and its version history.
 *
 *  DRAFT versus LIVE
 *    Edits only ever change the DRAFT. Students will only see the LIVE version,
 *    which is the last thing somebody published. Nothing a person types can reach
 *    students until "Publish" is pressed.
 *
 *  PUBLISH
 *    Saves a frozen SNAPSHOT of the whole draft as the next version number, with
 *    who published it, their role, when, a summary, and the list of what changed.
 *    It is refused when nothing changed, or when the draft was edited after the
 *    person reviewed the confirmation. Versions can never be edited or deleted.
 *
 *  COMPARE
 *    Any two of: the live version, a numbered version, the current draft. The
 *    answer lists every changed week, lesson and block, with line-by-line text
 *    differences. For the draft it also says who edited each item and when.
 *
 * Who may do this: the same people who may edit - admins, and the instructor
 * assigned to that cohort (instructors publish without admin review).
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentKind, EnrollmentStatus, Prisma, VersionSource } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import type { DbClient } from '../common/types/db-client';
import { PrismaService } from '../prisma/prisma.service';
import { ContentEditor } from './content-editor.service';
import type { PublishDto } from './dto/publish.dto';
import {
  Change,
  countChanges,
  diffSnapshots,
  summarizeChanges,
  toBrief,
} from './snapshot-diff';
import { countSnapshot, EMPTY_SNAPSHOT, ItemMeta, loadDraft, parseSnapshot, Snapshot } from './snapshot';

/** What we show about a saved version (never the snapshot itself). */
const versionSelect = {
  id: true,
  number: true,
  source: true,
  summary: true,
  changes: true,
  weekCount: true,
  lessonCount: true,
  blockCount: true,
  publishedById: true,
  publishedByRole: true,
  restoredFromNumber: true,
  createdAt: true,
} satisfies Prisma.CourseVersionSelect;

type VersionRow = Prisma.CourseVersionGetPayload<{ select: typeof versionSelect }>;

/** One side of a comparison, resolved. */
interface Side {
  version: number | null;
  snapshot: Snapshot;
  /** Only for the draft: who / when for each item. */
  meta: Map<string, ItemMeta> | null;
}

@Injectable()
export class CourseVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly editor: ContentEditor,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------ draft changes / preview

  /**
   * Everything the "Draft changes" panel and the publish confirmation need: what
   * differs between the live version and the draft (with who and when), the
   * version number a publish would create, a suggested summary, and who will see it.
   */
  async getDraftChanges(user: AuthenticatedUser, contentId: string) {
    await this.editor.open(user, contentId);

    const content = await this.prisma.courseContent.findUniqueOrThrow({
      where: { id: contentId },
      select: {
        kind: true,
        courseId: true,
        cohortId: true,
        draftRevision: true,
        publishedVersion: true,
        publishedAt: true,
        cohort: { select: { id: true, name: true } },
      },
    });

    const draft = await loadDraft(this.prisma, contentId);
    const live = await this.liveSnapshot(this.prisma, contentId, content.publishedVersion);
    const changes = diffSnapshots(live, draft.snapshot);
    const detailed = await this.withEditors(changes, draft.meta);

    const latest = await this.prisma.courseVersion.aggregate({ where: { contentId }, _max: { number: true } });

    return {
      /** Send this back when publishing, so nothing is published that was not reviewed. */
      draftRevision: content.draftRevision,
      live: content.publishedVersion === null ? null : { version: content.publishedVersion, publishedAt: content.publishedAt },
      nextVersion: (latest._max.number ?? 0) + 1,
      counts: countChanges(changes),
      changes: detailed.map(({ change, editedAt, editedBy }) => ({ ...toBrief(change), editedAt, editedBy })),
      suggestedSummary: summarizeChanges(changes),
      audience: await this.audienceOf(contentId, content),
    };
  }

  // ----------------------------------------------------------------- publish

  async publish(user: AuthenticatedUser, contentId: string, dto: PublishDto, context: RequestContext) {
    return this.editor.run(user, contentId, async (tx, content) => {
      if (dto.expectedDraftRevision !== undefined && dto.expectedDraftRevision !== content.draftRevision) {
        throw new ConflictException('The draft changed after you reviewed it. Review the changes again before publishing.');
      }

      const draft = await loadDraft(tx, contentId);
      const live = await this.liveSnapshot(tx, contentId, content.publishedVersion);
      const changes = diffSnapshots(live, draft.snapshot);
      if (changes.length === 0) {
        throw new ConflictException('There is nothing to publish: the draft is the same as the live version.');
      }

      const latest = await tx.courseVersion.aggregate({ where: { contentId }, _max: { number: true } });
      const number = (latest._max.number ?? 0) + 1;
      const counts = countSnapshot(draft.snapshot);

      const created = await tx.courseVersion.create({
        data: {
          contentId,
          number,
          source: VersionSource.PUBLISH,
          summary: dto.summary ?? summarizeChanges(changes),
          snapshot: draft.snapshot as unknown as Prisma.InputJsonObject,
          changes: changes.map(toBrief) as unknown as Prisma.InputJsonArray,
          weekCount: counts.weeks,
          lessonCount: counts.lessons,
          blockCount: counts.blocks,
          publishedById: user.id,
          publishedByRole: user.role,
        },
        select: versionSelect,
      });

      await tx.courseContent.update({
        where: { id: contentId },
        data: { publishedVersion: number, publishedAt: created.createdAt, publishedDraftRevision: content.draftRevision },
      });

      await this.audit.record(
        {
          actorId: user.id,
          action: 'course_content.published',
          entityType: 'course_content',
          entityId: contentId,
          metadata: { version: number, changes: changes.length, cohortId: content.cohortId },
          previousValue: { liveVersion: content.publishedVersion },
          newValue: { liveVersion: number },
          ipAddress: context.ipAddress,
        },
        tx,
      );

      return { version: this.toView(created, new Map([[user.id, user.fullName]]), number) };
    });
  }

  // ---------------------------------------------------------------- history

  /** The version history, newest first. */
  async listVersions(user: AuthenticatedUser, contentId: string) {
    await this.editor.open(user, contentId);

    const content = await this.prisma.courseContent.findUniqueOrThrow({
      where: { id: contentId },
      select: { draftRevision: true, publishedVersion: true, publishedDraftRevision: true },
    });
    const rows = await this.prisma.courseVersion.findMany({
      where: { contentId },
      orderBy: { number: 'desc' },
      select: versionSelect,
    });
    const names = await this.userNames(rows.map((row) => row.publishedById));

    return {
      live: content.publishedVersion,
      hasUnpublishedChanges: content.publishedVersion !== null && content.draftRevision !== content.publishedDraftRevision,
      versions: rows.map((row) => this.toView(row, names, content.publishedVersion)),
    };
  }

  /** One saved version with its whole contents ("View"). */
  async getVersion(user: AuthenticatedUser, contentId: string, number: number) {
    await this.editor.open(user, contentId);

    const content = await this.prisma.courseContent.findUniqueOrThrow({ where: { id: contentId }, select: { publishedVersion: true } });
    const row = await this.prisma.courseVersion.findUnique({
      where: { contentId_number: { contentId, number } },
      select: { ...versionSelect, snapshot: true },
    });
    if (!row) throw new NotFoundException(`Version ${number} not found.`);

    const names = await this.userNames([row.publishedById]);
    return { version: this.toView(row, names, content.publishedVersion), snapshot: parseSnapshot(row.snapshot) };
  }

  // ---------------------------------------------------------------- compare

  /** Compares two sides, each "live", "draft" or a version number. */
  async compare(user: AuthenticatedUser, contentId: string, fromRef: string, toRef: string) {
    await this.editor.open(user, contentId);

    const content = await this.prisma.courseContent.findUniqueOrThrow({ where: { id: contentId }, select: { publishedVersion: true } });
    const from = await this.resolve(contentId, fromRef, content.publishedVersion);
    const to = await this.resolve(contentId, toRef, content.publishedVersion);

    const changes = diffSnapshots(from.snapshot, to.snapshot);
    const detailed = await this.withEditors(changes, to.meta);

    return {
      from: { ref: fromRef, version: from.version },
      to: { ref: toRef, version: to.version },
      counts: countChanges(changes),
      summary: summarizeChanges(changes),
      changes: detailed.map(({ change, editedAt, editedBy }) => ({ ...change, editedAt, editedBy })),
    };
  }

  // ----------------------------------------------------------------- helpers

  private async resolve(contentId: string, ref: string, liveVersion: number | null): Promise<Side> {
    if (ref === 'draft') {
      const draft = await loadDraft(this.prisma, contentId);
      return { version: null, snapshot: draft.snapshot, meta: draft.meta };
    }

    const number = ref === 'live' ? liveVersion : Number(ref);
    if (number === null) return { version: null, snapshot: EMPTY_SNAPSHOT, meta: null }; // nothing published yet

    const row = await this.prisma.courseVersion.findUnique({
      where: { contentId_number: { contentId, number } },
      select: { snapshot: true },
    });
    if (!row) throw new NotFoundException(`Version ${number} not found.`);
    return { version: number, snapshot: parseSnapshot(row.snapshot), meta: null };
  }

  /** The live snapshot, or an empty one when nothing has been published yet. */
  private async liveSnapshot(db: DbClient, contentId: string, publishedVersion: number | null): Promise<Snapshot> {
    if (publishedVersion === null) return EMPTY_SNAPSHOT;
    const row = await db.courseVersion.findUnique({
      where: { contentId_number: { contentId, number: publishedVersion } },
      select: { snapshot: true },
    });
    if (!row) throw new NotFoundException(`The live version (${publishedVersion}) could not be found.`);
    return parseSnapshot(row.snapshot);
  }

  /** Adds "who edited it and when" to each change that still exists in the draft. */
  private async withEditors(changes: Change[], meta: Map<string, ItemMeta> | null) {
    const names = await this.userNames(
      changes.map((change) => meta?.get(change.id)?.editedById).filter((id): id is string => Boolean(id)),
    );

    return changes.map((change) => {
      const item = change.type === 'REMOVED' ? undefined : meta?.get(change.id);
      const who = item?.editedById ?? null;
      return {
        change,
        editedAt: item?.updatedAt ?? null,
        editedBy: who ? { id: who, fullName: names.get(who) ?? 'Unknown' } : null,
      };
    });
  }

  /** Who would see a publish: the students of this cohort, or - for a template - nobody yet. */
  private async audienceOf(
    contentId: string,
    content: { kind: ContentKind; courseId: string; cohortId: string | null; cohort: { id: string; name: string } | null },
  ) {
    if (content.kind === ContentKind.COHORT_COPY && content.cohort) {
      const activeStudents = await this.prisma.enrollment.count({
        where: { cohortId: content.cohort.id, status: EnrollmentStatus.ACTIVE },
      });
      return { type: 'COHORT' as const, cohort: content.cohort, activeStudents };
    }

    // A template is never shown to students; it is only the starting point for new cohorts.
    const cohortsWithCopies = await this.prisma.courseContent.count({
      where: { courseId: content.courseId, kind: ContentKind.COHORT_COPY },
    });
    return { type: 'TEMPLATE' as const, cohortsWithCopies };
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
    return new Map(users.map((user) => [user.id, user.fullName]));
  }

  private toView(row: VersionRow, names: Map<string, string>, liveVersion: number | null) {
    return {
      number: row.number,
      source: row.source,
      summary: row.summary,
      changeCount: Array.isArray(row.changes) ? row.changes.length : 0,
      counts: { weeks: row.weekCount, lessons: row.lessonCount, blocks: row.blockCount },
      publishedAt: row.createdAt,
      publishedBy: { id: row.publishedById, fullName: names.get(row.publishedById) ?? 'Unknown', role: row.publishedByRole },
      restoredFromNumber: row.restoredFromNumber,
      isLive: row.number === liveVersion,
    };
  }
}
