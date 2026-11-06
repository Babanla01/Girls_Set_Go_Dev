/**
 * course-planning.service.ts
 * ---------------------------------------------------------------------------
 * What a week PLANS besides its lessons: its assignment (with the rubric) and its
 * live class (date and time).
 *
 *  - At most ONE assignment and ONE live class per week (the database enforces it).
 *  - Both are part of the DRAFT: they go through the same gatekeeper as lessons
 *    (permissions, one editor at a time, "last edited by", closed cohorts and archived
 *    courses are frozen) and they are frozen into every published version.
 *  - The class date and time are entered in Chicago time and stored as an exact instant.
 *    The assignment's due date is NOT stored: it is worked out from the class (3 days
 *    after class at 5:00 PM Central), so moving the class moves the due date with it.
 *  - Removing an assignment is written to the audit log (ids only, never the text).
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CourseAssignment, CourseClassSession, Prisma } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import type { DbClient } from '../common/types/db-client';
import { localParts, zonedDateTimeToUtc } from '../common/utils/zoned-time';
import { branding } from '../config/branding.config';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentValues, buildAssignment, FileType, Rubric } from './assignment-data';
import { parseHttpUrl } from './block-data';
import { ContentEditor } from './content-editor.service';
import type { SaveAssignmentDto } from './dto/assignment.dto';
import type { SaveClassSessionDto } from './dto/class-session.dto';
import { assertFreshRevision } from './editing-helpers';

@Injectable()
export class CoursePlanningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly editor: ContentEditor,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- reading

  /** A week's assignment and live class together (what the week editor loads). */
  async getPlanning(user: AuthenticatedUser, contentId: string, weekId: string) {
    await this.editor.open(user, contentId);
    await this.requireWeek(this.prisma, contentId, weekId);

    const [assignment, session] = await Promise.all([
      this.prisma.courseAssignment.findUnique({ where: { weekId_contentId: { weekId, contentId } } }),
      this.prisma.courseClassSession.findUnique({ where: { weekId_contentId: { weekId, contentId } } }),
    ]);
    return {
      assignment: assignment ? this.assignmentView(assignment) : null,
      classSession: session ? this.sessionView(session) : null,
    };
  }

  // -------------------------------------------------------------- assignment

  /** Creates or updates the week's assignment (see SaveAssignmentDto). */
  async saveAssignment(user: AuthenticatedUser, contentId: string, weekId: string, dto: SaveAssignmentDto) {
    return this.editor.edit(user, contentId, async (tx) => {
      await this.requireWeek(tx, contentId, weekId);

      const existing = await tx.courseAssignment.findUnique({ where: { weekId_contentId: { weekId, contentId } } });
      if (existing) assertFreshRevision(existing.revision, dto.expectedRevision, 'assignment');

      const values = buildAssignment(dto, existing ? this.toValues(existing) : null);
      const data = {
        title: values.title,
        brief: values.brief,
        includes: values.includes,
        successEvidence: values.successEvidence,
        expectedMinutes: values.expectedMinutes,
        allowedFileTypes: values.allowedFileTypes,
        rubric: values.rubric as unknown as Prisma.InputJsonObject,
        rubricVisible: values.rubricVisible,
      };

      const saved = existing
        ? await tx.courseAssignment.update({ where: { id: existing.id }, data: { ...data, revision: { increment: 1 } } })
        : await tx.courseAssignment.create({ data: { contentId, weekId, ...data } });
      return { assignment: this.assignmentView(saved) };
    });
  }

  async removeAssignment(user: AuthenticatedUser, contentId: string, weekId: string, context: RequestContext) {
    return this.editor.edit(user, contentId, async (tx) => {
      await this.requireWeek(tx, contentId, weekId);

      const removed = await tx.courseAssignment.deleteMany({ where: { weekId, contentId } });
      if (removed.count === 0) throw new NotFoundException('This week has no assignment.');

      await this.audit.record(
        {
          actorId: user.id,
          action: 'course_content.assignment_removed',
          entityType: 'course_content',
          entityId: contentId,
          metadata: { weekId },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return { removed: true as const };
    });
  }

  // ------------------------------------------------------------ live class

  /** Sets the week's live class. Date and time are Chicago time. */
  async saveClassSession(user: AuthenticatedUser, contentId: string, weekId: string, dto: SaveClassSessionDto) {
    const problems: string[] = [];
    let joinUrl: string | null = null;
    if (dto.joinUrl) {
      const parsed = parseHttpUrl(dto.joinUrl);
      if (parsed) joinUrl = parsed.href;
      else problems.push('joinUrl must be a web address starting with http:// or https://.');
    }
    if (problems.length > 0) throw new BadRequestException(problems);

    const startsAt = zonedDateTimeToUtc(dto.date, dto.time, branding.timezone);

    return this.editor.edit(user, contentId, async (tx) => {
      await this.requireWeek(tx, contentId, weekId);

      const existing = await tx.courseClassSession.findUnique({ where: { weekId_contentId: { weekId, contentId } } });
      if (existing) assertFreshRevision(existing.revision, dto.expectedRevision, 'class session');

      const data = { startsAt, durationMinutes: dto.durationMinutes, joinUrl, notes: dto.notes ?? null };
      const saved = existing
        ? await tx.courseClassSession.update({ where: { id: existing.id }, data: { ...data, revision: { increment: 1 } } })
        : await tx.courseClassSession.create({ data: { contentId, weekId, ...data } });
      return { classSession: this.sessionView(saved) };
    });
  }

  async removeClassSession(user: AuthenticatedUser, contentId: string, weekId: string) {
    return this.editor.edit(user, contentId, async (tx) => {
      await this.requireWeek(tx, contentId, weekId);

      const removed = await tx.courseClassSession.deleteMany({ where: { weekId, contentId } });
      if (removed.count === 0) throw new NotFoundException('This week has no live class.');
      return { removed: true as const };
    });
  }

  // ----------------------------------------------------------------- helpers

  private async requireWeek(db: DbClient, contentId: string, weekId: string): Promise<void> {
    const week = await db.courseWeek.findFirst({ where: { id: weekId, contentId }, select: { id: true } });
    if (!week) throw new NotFoundException('Week not found.');
  }

  private toValues(row: CourseAssignment): AssignmentValues {
    return {
      title: row.title,
      brief: row.brief,
      includes: row.includes,
      successEvidence: row.successEvidence,
      expectedMinutes: row.expectedMinutes,
      allowedFileTypes: row.allowedFileTypes as FileType[],
      rubric: row.rubric as unknown as Rubric,
      rubricVisible: row.rubricVisible,
    };
  }

  private assignmentView(row: CourseAssignment) {
    return {
      id: row.id,
      weekId: row.weekId,
      title: row.title,
      brief: row.brief,
      includes: row.includes,
      successEvidence: row.successEvidence,
      expectedMinutes: row.expectedMinutes,
      allowedFileTypes: row.allowedFileTypes,
      rubric: row.rubric,
      rubricVisible: row.rubricVisible,
      revision: row.revision,
    };
  }

  private sessionView(row: CourseClassSession) {
    const local = localParts(row.startsAt, branding.timezone);
    return {
      id: row.id,
      weekId: row.weekId,
      /** Chicago date and time, as the instructor entered them. */
      date: local.date,
      time: local.time,
      timezone: branding.timezone,
      /** The exact moment (UTC), for showing the student's own local time. */
      startsAt: row.startsAt,
      durationMinutes: row.durationMinutes,
      joinUrl: row.joinUrl,
      notes: row.notes,
      revision: row.revision,
    };
  }
}
