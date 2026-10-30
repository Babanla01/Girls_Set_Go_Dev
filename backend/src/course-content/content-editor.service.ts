/**
 * content-editor.service.ts
 * ---------------------------------------------------------------------------
 * The gatekeeper for course content. Every read and every edit goes through it.
 *
 *   open()  checks that the content exists (404 otherwise) and that THIS person
 *           may open it (403 otherwise).
 *   edit()  does a change as the ONLY editor of that course copy:
 *             1. check the person may edit it;
 *             2. start a transaction and LOCK the copy, so two edits to the same
 *                course copy take turns instead of tangling;
 *             3. refuse if the cohort is closed or the course is archived;
 *             4. run the change;
 *             5. record who edited and when, and raise the draft revision.
 *           If anything fails, nothing is saved.
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

/** What the permission rule looks at. */
export interface ManageResource {
  kind: ContentKind;
  cohortId: string | null;
}

/** Locks one course copy until the end of the transaction (edits take turns). */
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

  /**
   * Runs `work` as the only editor of this course copy. Whatever `work` returns
   * is sent back together with the new draft revision.
   */
  async edit<T extends object>(
    user: AuthenticatedUser,
    contentId: string,
    work: (tx: DbClient, content: ContentRef) => Promise<T>,
  ): Promise<T & { draftRevision: number }> {
    const content = await this.open(user, contentId);

    return this.prisma.$transaction(async (tx) => {
      await lockContent(tx, contentId);

      // Checked again now that we hold the lock (an assignment may have just been removed).
      await this.policy.assertCan<ManageResource>(user, COURSE_CONTENT_MANAGE, content);
      await this.assertEditable(tx, content);

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
      throw new ConflictException('This course is archived, so its content cannot be edited.');
    }

    if (content.cohortId) {
      const cohort = await tx.cohort.findUniqueOrThrow({ where: { id: content.cohortId }, select: { status: true } });
      if (cohort.status === CohortStatus.CLOSED) {
        throw new ConflictException('This cohort is closed, so its course content cannot be edited.');
      }
    }
  }
}
