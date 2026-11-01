#!/usr/bin/env bash
# Batch 2B-2 - restore, discard draft, copy from the published template, admin course catalog.
# Run from the repo root. (No database migration is needed in this batch.)
set -euo pipefail
cd backend
mkdir -p src/course-content/dto

# The old copy helper is replaced by write-snapshot.ts (it is no longer used).
rm -f src/course-content/copy-content.ts

# ============================================================================
cat > src/course-content/write-snapshot.ts <<'EOF'
/**
 * write-snapshot.ts
 * ---------------------------------------------------------------------------
 * Writes a SNAPSHOT (a frozen picture of a course copy) into the editable draft
 * tables. It is used in two ways:
 *
 *   freshIds: true   COPYING (a new cohort's copy made from the template).
 *                    Every item gets a NEW id of its own and remembers the id it
 *                    came from (`originId`), which is what lets a later batch tell
 *                    "this is still the template's lesson" when updates are merged.
 *
 *   freshIds: false  RESTORING or DISCARDING (putting an earlier picture back).
 *                    Every item keeps its permanent id and its origin, so anything
 *                    that points at a lesson (such as a student's progress) keeps
 *                    pointing at the same lesson.
 *
 * Positions are written as 1, 2, 3 ... from the order of the lists.
 */
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { DbClient } from '../common/types/db-client';
import type { Snapshot, SnapshotCounts } from './snapshot';

/** Removes the whole draft of a course copy (its lessons and blocks go with their weeks). */
export async function clearDraft(db: DbClient, contentId: string): Promise<void> {
  await db.courseWeek.deleteMany({ where: { contentId } });
}

export async function writeSnapshot(
  db: DbClient,
  contentId: string,
  snapshot: Snapshot,
  options: { freshIds: boolean },
): Promise<SnapshotCounts> {
  const weekRows: Prisma.CourseWeekCreateManyInput[] = [];
  const lessonRows: Prisma.CourseLessonCreateManyInput[] = [];
  const blockRows: Prisma.LessonBlockCreateManyInput[] = [];

  // Copying: new id, origin = the id it came from. Restoring: same id, same origin.
  const identify = (id: string, originId: string | null) =>
    options.freshIds ? { id: randomUUID(), originId: id } : { id, originId };

  snapshot.weeks.forEach((week, weekIndex) => {
    const weekIdentity = identify(week.id, week.originId);
    weekRows.push({
      ...weekIdentity,
      contentId,
      position: weekIndex + 1,
      title: week.title,
      summary: week.summary,
    });

    week.lessons.forEach((lesson, lessonIndex) => {
      const lessonIdentity = identify(lesson.id, lesson.originId);
      lessonRows.push({
        ...lessonIdentity,
        contentId,
        weekId: weekIdentity.id,
        position: lessonIndex + 1,
        title: lesson.title,
        summary: lesson.summary,
        estimatedMinutes: lesson.estimatedMinutes,
      });

      lesson.blocks.forEach((block, blockIndex) => {
        blockRows.push({
          ...identify(block.id, block.originId),
          contentId,
          lessonId: lessonIdentity.id,
          position: blockIndex + 1,
          type: block.type,
          instructorOnly: block.instructorOnly,
          data: block.data as Prisma.InputJsonObject,
        });
      });
    });
  });

  // Parents first, so every lesson and block finds its week / lesson.
  if (weekRows.length > 0) await db.courseWeek.createMany({ data: weekRows });
  if (lessonRows.length > 0) await db.courseLesson.createMany({ data: lessonRows });
  if (blockRows.length > 0) await db.lessonBlock.createMany({ data: blockRows });

  return { weeks: weekRows.length, lessons: lessonRows.length, blocks: blockRows.length };
}
EOF

# ============================================================================
cat > src/course-content/dto/restore.dto.ts <<'EOF'
/**
 * restore.dto.ts - what the screen sends when the person confirms "Restore this version".
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** Trims the note; an empty box counts as "no note". */
const textOrUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class RestoreDto {
  /**
   * Restoring REPLACES the draft. If the draft has unpublished changes, the restore is
   * refused unless the person confirms that those changes may be thrown away.
   */
  @IsOptional()
  @IsBoolean()
  discardDraftChanges?: boolean;

  /** A short note for the new version. Leave out to get "Restored version N". */
  @IsOptional()
  @Transform(textOrUndefined)
  @IsString()
  @MaxLength(300)
  summary?: string;
}
EOF

cat > src/course-content/dto/discard-draft.dto.ts <<'EOF'
/**
 * discard-draft.dto.ts - what the screen sends when the person confirms "Discard draft changes".
 */
import { IsInt, IsOptional, Min } from 'class-validator';

export class DiscardDraftDto {
  /**
   * The draft revision the person reviewed. If someone edited the draft since, the discard
   * is refused so nobody throws away work they never saw.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedDraftRevision?: number;
}
EOF

cat > src/course-content/dto/course-catalog.query.ts <<'EOF'
/**
 * course-catalog.query.ts
 * ---------------------------------------------------------------------------
 *   ?trackId=<uuid>&status=PUBLISHED&search=intro&page=1&pageSize=20
 */
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CourseStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../common/pagination/pagination';

export class CourseCatalogQuery extends PaginationQueryDto {
  /** Matches part of the course title, ignoring capitals. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(150)
  search?: string;

  @IsOptional()
  @IsUUID()
  trackId?: string;

  @IsOptional()
  @IsEnum(CourseStatus)
  status?: CourseStatus;
}
EOF

# ============================================================================
cat > src/course-content/course-restore.service.ts <<'EOF'
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
EOF

# ============================================================================
cat > src/course-content/course-restore.controller.ts <<'EOF'
/**
 * course-restore.controller.ts
 * ---------------------------------------------------------------------------
 * The "go back" actions for a course copy (same people and rules as editing):
 *
 *   POST /api/v1/course-content/:contentId/versions/:number/restore   make an older version live again (as a new version)
 *   POST /api/v1/course-content/:contentId/discard-draft              throw away unpublished changes, back to the live version
 */
import { Body, Controller, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CourseRestoreService } from './course-restore.service';
import { DiscardDraftDto } from './dto/discard-draft.dto';
import { RestoreDto } from './dto/restore.dto';

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('course-content')
export class CourseRestoreController {
  constructor(private readonly restoring: CourseRestoreService) {}

  @Post(':contentId/versions/:number/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', new ParseUUIDPipe()) contentId: string,
    @Param('number', new ParseIntPipe()) number: number,
    @Body() dto: RestoreDto,
    @Req() req: Request,
  ) {
    return this.restoring.restore(user, contentId, number, dto, getRequestContext(req));
  }

  @Post(':contentId/discard-draft')
  @HttpCode(200)
  discardDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contentId', new ParseUUIDPipe()) contentId: string,
    @Body() dto: DiscardDraftDto,
    @Req() req: Request,
  ) {
    return this.restoring.discardDraft(user, contentId, dto, getRequestContext(req));
  }
}
EOF

# ============================================================================
cat > src/course-content/course-content.service.ts <<'EOF'
/**
 * course-content.service.ts
 * ---------------------------------------------------------------------------
 * Finding (and, the first time, creating) the editable copies of a course, and
 * reading them.
 *
 *  - Every course has ONE master TEMPLATE. Admins build it; it is never shown
 *    to students.
 *  - Every cohort has its OWN COPY, made from the template the first time it is
 *    opened. The copy starts from the template's PUBLISHED version (so a
 *    half-finished template draft never leaks into a cohort); if the template has
 *    never been published, it starts from the template's current draft.
 *    The copy is NOT live to students until someone publishes it.
 *  - Instructors of that cohort edit their copy without touching the template or
 *    other cohorts.
 *  - Creating a copy is safe when two people open it at the same moment: the
 *    database allows only one, and the other simply gets that one back.
 *  - Closed cohorts and archived courses do not get new copies.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CohortStatus, ContentKind, CourseStatus } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { PolicyService } from '../auth/policy/policy.service';
import { AuditService } from '../common/audit/audit.service';
import type { DbClient } from '../common/types/db-client';
import { PrismaService } from '../prisma/prisma.service';
import { COURSE_CONTENT_MANAGE } from './course-content.constants';
import {
  blockSelect,
  contentSelect,
  lessonSelect,
  toBlockView,
  toContentView,
  toLessonView,
  weekSelect,
  toWeekView,
} from './course-content.view';
import { ContentEditor, lockContent, ManageResource } from './content-editor.service';
import { loadDraft, parseSnapshot, Snapshot } from './snapshot';
import { writeSnapshot } from './write-snapshot';

@Injectable()
export class CourseContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly editor: ContentEditor,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------ reading

  /** The whole course copy as an outline: its weeks and the lessons in each (no block contents). */
  async getOutline(user: AuthenticatedUser, contentId: string) {
    await this.editor.open(user, contentId);
    return this.buildOutline(this.prisma, contentId);
  }

  /** One lesson with all its blocks, in order. */
  async getLesson(user: AuthenticatedUser, contentId: string, lessonId: string) {
    await this.editor.open(user, contentId);

    const lesson = await this.prisma.courseLesson.findFirst({
      where: { id: lessonId, contentId },
      select: { ...lessonSelect, blocks: { orderBy: [{ position: 'asc' }, { id: 'asc' }], select: blockSelect } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found.');

    return { lesson: toLessonView(lesson), blocks: lesson.blocks.map(toBlockView) };
  }

  // ------------------------------------------------- the master template

  /** The course's master template (created empty the first time). Admins only. */
  async getOrCreateTemplate(admin: AuthenticatedUser, courseId: string, context: RequestContext) {
    await this.policy.assertCan<ManageResource>(admin, COURSE_CONTENT_MANAGE, { kind: ContentKind.TEMPLATE, cohortId: null });

    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { status: true } });
    if (!course) throw new NotFoundException('Course not found.');

    let template = await this.prisma.courseContent.findFirst({
      where: { courseId, kind: ContentKind.TEMPLATE },
      select: { id: true },
    });

    if (!template) {
      if (course.status === CourseStatus.ARCHIVED) {
        throw new ConflictException('This course is archived, so it cannot get a new template.');
      }
      template = await this.prisma.$transaction(async (tx) => {
        const created = await this.ensureTemplate(tx, courseId);
        if (created.isNew) {
          await this.audit.record(
            {
              actorId: admin.id,
              action: 'course_content.template_created',
              entityType: 'course_content',
              entityId: created.id,
              metadata: { courseId },
              ipAddress: context.ipAddress,
            },
            tx,
          );
        }
        return { id: created.id };
      });
    }

    return this.buildOutline(this.prisma, template.id);
  }

  // ------------------------------------------------------ a cohort's copy

  /**
   * The copy of the course that belongs to ONE cohort (created from the template
   * the first time it is opened). Admins, and the instructors assigned to that cohort.
   */
  async getOrCreateCohortCopy(user: AuthenticatedUser, cohortId: string, context: RequestContext) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      select: { id: true, courseId: true, status: true },
    });
    if (!cohort) throw new NotFoundException('Cohort not found.');

    await this.policy.assertCan<ManageResource>(user, COURSE_CONTENT_MANAGE, { kind: ContentKind.COHORT_COPY, cohortId });

    const existing = await this.prisma.courseContent.findUnique({ where: { cohortId }, select: { id: true } });
    if (existing) return this.buildOutline(this.prisma, existing.id);

    if (cohort.status === CohortStatus.CLOSED) {
      throw new ConflictException('This cohort is closed, so it cannot get new course content.');
    }
    const course = await this.prisma.course.findUniqueOrThrow({ where: { id: cohort.courseId }, select: { status: true } });
    if (course.status === CourseStatus.ARCHIVED) {
      throw new ConflictException('This course is archived, so its cohorts cannot get new course content.');
    }

    const contentId = await this.createCohortCopy(user, cohort, context);
    return this.buildOutline(this.prisma, contentId);
  }

  // ----------------------------------------------------------------- helpers

  private async createCohortCopy(
    user: AuthenticatedUser,
    cohort: { id: string; courseId: string },
    context: RequestContext,
  ): Promise<string> {
    return this.prisma.$transaction(
      async (tx) => {
        const template = await this.ensureTemplate(tx, cohort.courseId);

        // Nobody can edit or publish the template while we copy it, so the copy is consistent.
        await lockContent(tx, template.id);

        // Start from the template's PUBLISHED version; if it was never published, from its draft.
        const state = await tx.courseContent.findUniqueOrThrow({
          where: { id: template.id },
          select: { publishedVersion: true },
        });
        let source: Snapshot;
        if (state.publishedVersion !== null) {
          const version = await tx.courseVersion.findUniqueOrThrow({
            where: { contentId_number: { contentId: template.id, number: state.publishedVersion } },
            select: { snapshot: true },
          });
          source = parseSnapshot(version.snapshot);
        } else {
          source = (await loadDraft(tx, template.id)).snapshot;
        }

        // If another request created the copy a moment ago, the database ignores this
        // insert (count 0) and we simply hand back theirs instead of copying twice.
        const inserted = await tx.courseContent.createMany({
          data: [
            {
              kind: ContentKind.COHORT_COPY,
              courseId: cohort.courseId,
              cohortId: cohort.id,
              baseTemplateVersion: state.publishedVersion ?? 0,
            },
          ],
          skipDuplicates: true,
        });
        const copy = await tx.courseContent.findUniqueOrThrow({ where: { cohortId: cohort.id }, select: { id: true } });
        if (inserted.count === 0) return copy.id;

        const counts = await writeSnapshot(tx, copy.id, source, { freshIds: true });
        await this.audit.record(
          {
            actorId: user.id,
            action: 'course_content.cohort_copy_created',
            entityType: 'course_content',
            entityId: copy.id,
            metadata: {
              cohortId: cohort.id,
              courseId: cohort.courseId,
              copiedFrom: state.publishedVersion === null ? 'TEMPLATE_DRAFT' : 'TEMPLATE_PUBLISHED',
              templateVersion: state.publishedVersion,
              ...counts,
            },
            ipAddress: context.ipAddress,
          },
          tx,
        );
        return copy.id;
      },
      { timeout: 30_000 }, // copying a large template can take a few seconds
    );
  }

  /** Finds the course's template, creating it (empty) if there is none yet. Safe when two requests race. */
  private async ensureTemplate(tx: DbClient, courseId: string): Promise<{ id: string; isNew: boolean }> {
    const inserted = await tx.courseContent.createMany({
      data: [{ kind: ContentKind.TEMPLATE, courseId }],
      skipDuplicates: true,
    });
    const template = await tx.courseContent.findFirstOrThrow({
      where: { courseId, kind: ContentKind.TEMPLATE },
      select: { id: true },
    });
    return { id: template.id, isNew: inserted.count > 0 };
  }

  private async buildOutline(db: DbClient, contentId: string) {
    const content = await db.courseContent.findUniqueOrThrow({ where: { id: contentId }, select: contentSelect });

    const weeks = await db.courseWeek.findMany({
      where: { contentId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: {
        ...weekSelect,
        lessons: {
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: { ...lessonSelect, _count: { select: { blocks: true } } },
        },
      },
    });

    const outline = weeks.map((week) => ({
      ...toWeekView(week),
      lessons: week.lessons.map((lesson) => ({ ...toLessonView(lesson), blockCount: lesson._count.blocks })),
    }));

    const lessonCount = outline.reduce((total, week) => total + week.lessons.length, 0);
    const blockCount = outline.reduce(
      (total, week) => total + week.lessons.reduce((sum, lesson) => sum + lesson.blockCount, 0),
      0,
    );

    return {
      content: toContentView(content),
      counts: { weeks: outline.length, lessons: lessonCount, blocks: blockCount },
      weeks: outline,
    };
  }
}
EOF

# ============================================================================
cat > src/course-content/course-catalog.service.ts <<'EOF'
/**
 * course-catalog.service.ts
 * ---------------------------------------------------------------------------
 * The admin's overview of every course: its master template and each cohort's
 * copy, with how many lessons there are and whether students can see anything
 * yet. It answers "what is published where, and what is still a draft?" in one
 * page of results, using a fixed number of queries however many courses there are.
 *
 * For every template or cohort copy the catalog says:
 *   status  NOT_PUBLISHED        nothing is live yet (students see nothing)
 *           PUBLISHED            the live version is up to date with the draft
 *           UNPUBLISHED_CHANGES  something is live, but the draft has changes waiting
 *   liveLessons   lessons in the live version (empty if nothing is live)
 *   draftLessons  lessons in the draft right now
 */
import { Injectable } from '@nestjs/common';
import { ContentKind, Prisma } from '@prisma/client';

import { formatCalendarDate } from '../catalog/catalog.util';
import { buildPage, Paginated, toSkipTake } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { CourseCatalogQuery } from './dto/course-catalog.query';

export type ContentStatus = 'NOT_PUBLISHED' | 'PUBLISHED' | 'UNPUBLISHED_CHANGES';

export interface ContentSummary {
  contentId: string;
  status: ContentStatus;
  liveVersion: number | null;
  publishedAt: Date | null;
  liveLessons: number | null;
  draftLessons: number;
}

export interface CatalogCourse {
  id: string;
  title: string;
  status: string;
  track: { id: string; name: string };
  /** The course's master template (null until an admin first opens it). */
  template: ContentSummary | null;
  cohorts: {
    id: string;
    name: string;
    status: string;
    startsOn: string;
    endsOn: string;
    /** This cohort's own copy (null until it is first opened). */
    content: ContentSummary | null;
  }[];
}

@Injectable()
export class CourseCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: CourseCatalogQuery): Promise<Paginated<CatalogCourse>> {
    const where: Prisma.CourseWhereInput = {
      ...(query.trackId ? { trackId: query.trackId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [total, courses] = await Promise.all([
      this.prisma.course.count({ where }),
      this.prisma.course.findMany({
        where,
        orderBy: [{ track: { name: 'asc' } }, { title: 'asc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: { id: true, title: true, status: true, track: { select: { id: true, name: true } } },
      }),
    ]);
    if (courses.length === 0) return buildPage([], total, query);

    const courseIds = courses.map((course) => course.id);

    // Four more queries for the whole page, no matter how many courses it holds.
    const [cohorts, contents] = await Promise.all([
      this.prisma.cohort.findMany({
        where: { courseId: { in: courseIds } },
        orderBy: [{ startsOn: 'desc' }, { id: 'asc' }],
        select: { id: true, courseId: true, name: true, status: true, startsOn: true, endsOn: true },
      }),
      this.prisma.courseContent.findMany({
        where: { courseId: { in: courseIds } },
        select: {
          id: true,
          kind: true,
          courseId: true,
          cohortId: true,
          publishedVersion: true,
          publishedAt: true,
          draftRevision: true,
          publishedDraftRevision: true,
        },
      }),
    ]);

    const contentIds = contents.map((content) => content.id);
    const [versions, draftLessonCounts] = await Promise.all([
      this.prisma.courseVersion.findMany({
        where: { contentId: { in: contentIds } },
        select: { contentId: true, number: true, lessonCount: true },
      }),
      this.prisma.courseLesson.groupBy({
        by: ['contentId'],
        where: { contentId: { in: contentIds } },
        _count: { _all: true },
      }),
    ]);

    const liveLessons = new Map(versions.map((version) => [`${version.contentId}:${version.number}`, version.lessonCount]));
    const draftLessons = new Map(draftLessonCounts.map((row) => [row.contentId, row._count._all]));

    const summarize = (content: (typeof contents)[number]): ContentSummary => {
      const live = content.publishedVersion;
      return {
        contentId: content.id,
        status:
          live === null
            ? 'NOT_PUBLISHED'
            : content.draftRevision !== content.publishedDraftRevision
              ? 'UNPUBLISHED_CHANGES'
              : 'PUBLISHED',
        liveVersion: live,
        publishedAt: content.publishedAt,
        liveLessons: live === null ? null : (liveLessons.get(`${content.id}:${live}`) ?? 0),
        draftLessons: draftLessons.get(content.id) ?? 0,
      };
    };

    const templateOf = new Map<string, ContentSummary>();
    const copyOf = new Map<string, ContentSummary>();
    for (const content of contents) {
      if (content.kind === ContentKind.TEMPLATE) templateOf.set(content.courseId, summarize(content));
      else if (content.cohortId) copyOf.set(content.cohortId, summarize(content));
    }

    const items = courses.map(
      (course): CatalogCourse => ({
        id: course.id,
        title: course.title,
        status: course.status,
        track: course.track,
        template: templateOf.get(course.id) ?? null,
        cohorts: cohorts
          .filter((cohort) => cohort.courseId === course.id)
          .map((cohort) => ({
            id: cohort.id,
            name: cohort.name,
            status: cohort.status,
            startsOn: formatCalendarDate(cohort.startsOn),
            endsOn: formatCalendarDate(cohort.endsOn),
            content: copyOf.get(cohort.id) ?? null,
          })),
      }),
    );

    return buildPage(items, total, query);
  }
}
EOF

cat > src/course-content/course-catalog.controller.ts <<'EOF'
/**
 * course-catalog.controller.ts
 * ---------------------------------------------------------------------------
 * Admin-only overview of every course, its master template and each cohort's copy.
 *
 *   GET /api/v1/admin/course-catalog?trackId=&status=&search=&page=&pageSize=
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { CourseCatalogService } from './course-catalog.service';
import { CourseCatalogQuery } from './dto/course-catalog.query';

@Roles(Role.ADMIN)
@Controller('admin/course-catalog')
export class CourseCatalogController {
  constructor(private readonly catalog: CourseCatalogService) {}

  @Get()
  list(@Query() query: CourseCatalogQuery) {
    return this.catalog.list(query);
  }
}
EOF

# ============================================================================
cat > src/course-content/course-content.module.ts <<'EOF'
/**
 * course-content.module.ts
 * ---------------------------------------------------------------------------
 * Building a course: its master template, each cohort's own copy, the weeks,
 * lessons and blocks inside them (the draft content), publishing them as numbered
 * versions, going back (restore / discard), and the admin's course catalog.
 *
 * It also REGISTERS the ownership rule "who may open / edit a course copy" with
 * the permission framework (deny by default):
 *   - an admin: any template or cohort copy;
 *   - an instructor: only the copy of a cohort assigned to her;
 *   - everyone else: nothing.
 * The rule is checked against the database on EVERY request, never remembered.
 */
import { Module, OnModuleInit } from '@nestjs/common';
import { ContentKind, Role } from '@prisma/client';

import { AuthModule } from '../auth/auth.module';
import { PolicyService } from '../auth/policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContentEditor, ManageResource } from './content-editor.service';
import { COURSE_CONTENT_MANAGE } from './course-content.constants';
import { CourseCatalogController } from './course-catalog.controller';
import { CourseCatalogService } from './course-catalog.service';
import { CourseContentController } from './course-content.controller';
import { CourseContentService } from './course-content.service';
import { CourseRestoreController } from './course-restore.controller';
import { CourseRestoreService } from './course-restore.service';
import { CourseStructureService } from './course-structure.service';
import { CourseVersionsService } from './course-versions.service';
import { LessonBlocksService } from './lesson-blocks.service';

@Module({
  imports: [AuthModule],
  controllers: [CourseContentController, CourseRestoreController, CourseCatalogController],
  providers: [
    ContentEditor,
    CourseContentService,
    CourseStructureService,
    LessonBlocksService,
    CourseVersionsService,
    CourseRestoreService,
    CourseCatalogService,
  ],
  exports: [ContentEditor, CourseVersionsService],
})
export class CourseContentModule implements OnModuleInit {
  constructor(
    private readonly policy: PolicyService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.policy.register<ManageResource>(COURSE_CONTENT_MANAGE, async (user, resource) => {
      if (user.role === Role.ADMIN) return true;
      if (user.role !== Role.INSTRUCTOR) return false;

      // An instructor works only on a cohort's copy, and only for a cohort assigned to her.
      if (resource.kind !== ContentKind.COHORT_COPY || !resource.cohortId) return false;
      const assignments = await this.prisma.cohortInstructor.count({
        where: { cohortId: resource.cohortId, instructorId: user.id },
      });
      return assignments > 0;
    });
  }
}
EOF

echo "Batch 2B-2 files created. No migration is needed; nothing else to replace."