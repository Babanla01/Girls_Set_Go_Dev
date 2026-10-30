/**
 * course-content.service.ts
 * ---------------------------------------------------------------------------
 * Finding (and, the first time, creating) the editable copies of a course, and
 * reading them.
 *
 *  - Every course has ONE master TEMPLATE. Admins build it; it is never shown
 *    to students.
 *  - Every cohort has its OWN COPY, made from the template the first time it is
 *    opened. Instructors of that cohort edit their copy without touching the
 *    template or other cohorts.
 *  - Creating a copy is safe when two people open it at the same moment: the
 *    database allows only one, and the other simply gets that one back.
 *  - Closed cohorts and archived courses do not get new copies.
 *
 * Everything here is the DRAFT (working) content. Publishing, versions and what
 * students see come in the next batch.
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
import { copyContent } from './copy-content';

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

        // Nobody can edit the template while we copy it, so the copy is consistent.
        await lockContent(tx, template.id);

        // If another request created the copy a moment ago, the database ignores this
        // insert (count 0) and we simply hand back theirs instead of copying twice.
        const inserted = await tx.courseContent.createMany({
          data: [{ kind: ContentKind.COHORT_COPY, courseId: cohort.courseId, cohortId: cohort.id, baseTemplateVersion: 0 }],
          skipDuplicates: true,
        });
        const copy = await tx.courseContent.findUniqueOrThrow({ where: { cohortId: cohort.id }, select: { id: true } });
        if (inserted.count === 0) return copy.id;

        const counts = await copyContent(tx, template.id, copy.id);
        await this.audit.record(
          {
            actorId: user.id,
            action: 'course_content.cohort_copy_created',
            entityType: 'course_content',
            entityId: copy.id,
            metadata: { cohortId: cohort.id, courseId: cohort.courseId, ...counts },
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
