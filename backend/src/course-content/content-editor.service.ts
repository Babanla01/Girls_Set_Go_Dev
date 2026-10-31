/**
 * content-editor.service.ts
 * ---------------------------------------------------------------------------
 * The gatekeeper for course content. Every read and every edit goes through it.
 *
 *   open()  checks that the content exists (404 otherwise) and that THIS person
 *           may open it (403 otherwise).
 *   run()   does something as the ONLY person working on that course copy:
 *             1. check the person may work on it;
 *             2. start a transaction and LOCK the copy, so two actions on the same
 *                course copy take turns instead of tangling;
 *             3. tell the database who is acting (it stamps "last edited by" on
 *                every week, lesson and block that gets written);
 *             4. refuse if the cohort is closed or the course is archived;
 *             5. run the work. If anything fails, nothing is saved.
 *   edit()  is run() for DRAFT edits: afterwards it also records who edited and
 *           when, and raises the draft revision.
 *
 * Who may do what (decided by one rule, checked against the database on EVERY
 * request - so an admin removing an assignment takes effect on the next click):
 *   - an ADMIN: any course template, and any cohort's copy;
 *   - an INSTRUCTOR: only the copy of a cohort that is assigned to her;
 *   - anyone else: nothing.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CohortStatus, ContentKind, CourseStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PolicyService } from '../auth/policy/policy.service';
import type { DbClient } from '../common/types/db-client';
import { PrismaService } from '../prisma/prisma.service';
import { COURSE_CONTENT_MANAGE } from './course-content.constants';

/** The few facts needed to decide who may touch a course copy. */
export interface ContentRef {
  id: string;
  kind: ContentKind;
  courseId: string;
  cohortId: string | null;
}

/** A course copy as it is while we hold its lock: the facts above plus where publishing stands. */
export interface LockedContent extends ContentRef {
  draftRevision: number;
  /** The live version number (empty = nothing published yet). */
  publishedVersion: number | null;
  publishedDraftRevision: number | null;
}

/** What the permission rule looks at. */
export interface ManageResource {
  kind: ContentKind;
  cohortId: string | null;
}

/** Locks one course copy until the end of the transaction (actions take turns). */
export async function lockContent(db: DbClient, contentId: string): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "course_contents" WHERE "id" = ${contentId}::uuid FOR UPDATE`;
}

@Injectable()
export class ContentEditor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
  ) {}

  /** 404 if it does not exist, 403 if it is not this person's to open. */
  async open(user: AuthenticatedUser, contentId: string): Promise<ContentRef> {
    const content = await this.prisma.courseContent.findUnique({
      where: { id: contentId },
      select: { id: true, kind: true, courseId: true, cohortId: true },
    });
    if (!content) throw new NotFoundException('Course content not found.');

    await this.policy.assertCan<ManageResource>(user, COURSE_CONTENT_MANAGE, content);
    return content;
  }

  /** Runs `work` as the only person working on this course copy (see the notes at the top). */
  async run<T>(
    user: AuthenticatedUser,
    contentId: string,
    work: (tx: DbClient, content: LockedContent) => Promise<T>,
  ): Promise<T> {
    const ref = await this.open(user, contentId);

    return this.prisma.$transaction(async (tx) => {
      await lockContent(tx, contentId);

      // Tell the database who is acting, for this transaction only. A trigger stamps it
      // on every week, lesson and block written from here on ("last edited by").
      await tx.$queryRaw`SELECT set_config('app.user_id', ${user.id}, true)`;

      // Checked again now that we hold the lock (an assignment may have just been removed).
      await this.policy.assertCan<ManageResource>(user, COURSE_CONTENT_MANAGE, ref);
      await this.assertEditable(tx, ref);

      const locked = await tx.courseContent.findUniqueOrThrow({
        where: { id: contentId },
        select: {
          id: true,
          kind: true,
          courseId: true,
          cohortId: true,
          draftRevision: true,
          publishedVersion: true,
          publishedDraftRevision: true,
        },
      });
      return work(tx, locked);
    });
  }

  /**
   * Runs a DRAFT edit. Whatever `work` returns is sent back together with the new
   * draft revision.
   */
  async edit<T extends object>(
    user: AuthenticatedUser,
    contentId: string,
    work: (tx: DbClient, content: ContentRef) => Promise<T>,
  ): Promise<T & { draftRevision: number }> {
    return this.run(user, contentId, async (tx, content) => {
      const result = await work(tx, content);

      const saved = await tx.courseContent.update({
        where: { id: contentId },
        data: { draftRevision: { increment: 1 }, lastEditedById: user.id, lastEditedAt: new Date() },
        select: { draftRevision: true },
      });
      return { ...result, draftRevision: saved.draftRevision };
    });
  }

  /** Content of an archived course or a closed cohort is frozen. */
  private async assertEditable(tx: DbClient, content: ContentRef): Promise<void> {
    const course = await tx.course.findUniqueOrThrow({ where: { id: content.courseId }, select: { status: true } });
    if (course.status === CourseStatus.ARCHIVED) {
      throw new ConflictException('This course is archived, so its content cannot be changed.');
    }

    if (content.cohortId) {
      const cohort = await tx.cohort.findUniqueOrThrow({ where: { id: content.cohortId }, select: { status: true } });
      if (cohort.status === CohortStatus.CLOSED) {
        throw new ConflictException('This cohort is closed, so its course content cannot be changed.');
      }
    }
  }
}
