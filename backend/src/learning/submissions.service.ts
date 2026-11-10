/**
 * submissions.service.ts
 * ---------------------------------------------------------------------------
 * A student sending in her work.
 *
 * What she can send: up to 5 files (only the types the assignment allows, checked by their
 * real contents), and/or a link, and a written note - at least one file or a link.
 *
 * VERSIONS. The first send is version 1. Every version is read-only for ever (the database
 * refuses changes). To change her work she sends a NEW version:
 *   - at any time until the assignment CLOSES (7 days after the due time), unless it was
 *     marked complete;
 *   - after it has closed, only when an instructor asked for changes ("Needs revision"), and
 *     only until the date they set.
 * A new version puts the submission back to "Submitted" so it gets looked at again.
 *
 * LATE. A version sent after the due time (but before the close) is stored as Late, at the
 * moment it is sent - moving the class date later never changes it. A version sent because
 * an instructor asked for changes is never Late.
 *
 * Each submission has a receipt (GSG-SUB-n) made by the database, and each version records
 * which published course version she answered, so later edits to the course never change
 * what she was asked.
 *
 * SAFETY. Nothing is stored until every check passed. Files are saved first, then the
 * records are written in ONE transaction; if that fails, the saved files are removed again.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SubmissionStatus } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import { parseHttpUrl } from '../course-content/block-data';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService, StoredFileView } from '../storage/storage.service';
import { MAX_UPLOAD_BYTES } from '../storage/storage.constants';
import { checkUploads, IncomingFile } from '../storage/upload-checks';
import { AssignmentContextService } from './assignment-context.service';
import { phaseAt, scheduleFor, submitDecision } from './assignment-rules';
import type { SubmitDto } from './dto/submit.dto';
import { READ_ONLY_MESSAGE } from './learning.constants';
import { MAX_SUBMISSION_FILES } from './submission.constants';

/** What the assignment list shows about a submission. */
export interface SubmissionSummary {
  reference: string;
  status: SubmissionStatus;
  revisionOpenUntil: Date | null;
  version: number;
  versionCount: number;
  isLate: boolean;
  submittedAt: Date;
}

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: AssignmentContextService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ submit

  async submit(
    user: AuthenticatedUser,
    assignmentId: string,
    uploads: readonly IncomingFile[],
    dto: SubmitDto,
    requestContext: RequestContext,
  ) {
    const ctx = await this.context.requireReady(user);
    if (ctx.readOnly) throw new ForbiddenException(READ_ONLY_MESSAGE);

    const { snapshot, weeks } = await this.context.load(ctx);
    const index = snapshot.weeks.findIndex((week) => week.assignment?.id === assignmentId);
    const week = snapshot.weeks[index];
    const assignment = week?.assignment;
    if (!week || !assignment) throw new NotFoundException('Assignment not found.');
    if (!weeks[index].open) throw new ForbiddenException(weeks[index].lockedReason?.message ?? 'This week is not open yet.');

    const schedule = scheduleFor(week.classSession ? new Date(week.classSession.startsAt) : null);

    // 1) Her input, checked completely before anything is stored.
    const problems: string[] = [];
    let linkUrl: string | null = null;
    if (dto.linkUrl) {
      const parsed = parseHttpUrl(dto.linkUrl);
      if (parsed) linkUrl = parsed.href;
      else problems.push('The link must be a web address starting with http:// or https://.');
    }
    const checked = checkUploads(uploads, assignment.allowedFileTypes, {
      maxFiles: MAX_SUBMISSION_FILES,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    problems.push(...checked.problems);
    if (problems.length === 0 && checked.files.length === 0 && !linkUrl) problems.push('Add at least one file or a link.');
    if (problems.length > 0) throw new BadRequestException(problems);

    // 2) A quick look so that a refused submission never writes a file.
    const existing = await this.prisma.submission.findUnique({
      where: { enrollmentId_assignmentId: { enrollmentId: ctx.enrollmentId, assignmentId } },
      select: { status: true, revisionOpenUntil: true, _count: { select: { versions: true } } },
    });
    const early = submitDecision({
      phase: phaseAt(schedule, new Date()),
      status: existing?.status ?? null,
      revisionOpenUntil: existing?.revisionOpenUntil ?? null,
      now: new Date(),
      versionCount: existing?._count.versions ?? 0,
    });
    if (!early.allowed) throw new ConflictException(early.reason);

    // 3) Store the files, then 4) write the records in one transaction.
    const saved: StoredFileView[] = [];
    try {
      for (const file of checked.files) {
        saved.push(
          await this.storage.save({
            name: file.name,
            contentType: file.contentType,
            buffer: file.buffer,
            sha256: file.sha256,
            uploadedById: user.id,
          }),
        );
      }

      await this.prisma.$transaction(async (tx) => {
        // Make sure the row exists, then take turns with any other send for the same assignment.
        await tx.submission.createMany({
          data: [{ enrollmentId: ctx.enrollmentId, assignmentId, weekId: week.id }],
          skipDuplicates: true,
        });
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "submissions"
           WHERE "enrollment_id" = ${ctx.enrollmentId}::uuid AND "assignment_id" = ${assignmentId}::uuid
             FOR UPDATE
        `;
        const submissionId = locked[0].id;

        const current = await tx.submission.findUniqueOrThrow({
          where: { id: submissionId },
          select: {
            status: true,
            revisionOpenUntil: true,
            versions: { orderBy: { number: 'desc' }, take: 1, select: { number: true } },
          },
        });
        const versionCount = current.versions[0]?.number ?? 0;
        const now = new Date();

        // The final decision, made while holding the lock.
        const decision = submitDecision({
          phase: phaseAt(schedule, now),
          status: versionCount === 0 ? null : current.status,
          revisionOpenUntil: current.revisionOpenUntil,
          now,
          versionCount,
        });
        if (!decision.allowed) throw new ConflictException(decision.reason);

        await tx.submissionVersion.create({
          data: {
            submissionId,
            number: versionCount + 1,
            courseVersion: ctx.version,
            isLate: decision.isLate,
            linkUrl,
            note: dto.note ?? null,
            files: { create: saved.map((file, position) => ({ fileId: file.id, position: position + 1 })) },
          },
        });
        await tx.submission.update({ where: { id: submissionId }, data: { status: SubmissionStatus.SUBMITTED, revisionOpenUntil: null } });

        await this.audit.record(
          {
            actorId: user.id,
            action: 'submission.submitted',
            entityType: 'submission',
            entityId: submissionId,
            metadata: { assignmentId, version: versionCount + 1, late: decision.isLate, files: saved.length },
            ipAddress: requestContext.ipAddress,
          },
          tx,
        );
      });
    } catch (error) {
      await this.discard(saved); // nothing is left behind when something fails
      throw error;
    }

    return { submission: await this.fullView(ctx.enrollmentId, assignmentId) };
  }

  // ------------------------------------------------------------------- views

  /** One short line per submission, for the assignment list (one query). */
  async summaries(enrollmentId: string): Promise<Map<string, SubmissionSummary>> {
    const rows = await this.prisma.submission.findMany({
      where: { enrollmentId },
      select: {
        assignmentId: true,
        reference: true,
        status: true,
        revisionOpenUntil: true,
        _count: { select: { versions: true } },
        versions: { orderBy: { number: 'desc' }, take: 1, select: { number: true, isLate: true, createdAt: true } },
      },
    });

    return new Map(
      rows.flatMap((row) => {
        const latest = row.versions[0];
        if (!latest) return []; // a row that never got a version is not a submission
        return [
          [
            row.assignmentId,
            {
              reference: row.reference,
              status: row.status,
              revisionOpenUntil: row.revisionOpenUntil,
              version: latest.number,
              versionCount: row._count.versions,
              isLate: latest.isLate,
              submittedAt: latest.createdAt,
            },
          ] as const,
        ];
      }),
    );
  }

  /** The whole submission - every version with its files and fresh short-lived links. */
  async fullView(enrollmentId: string, assignmentId: string) {
    const submission = await this.prisma.submission.findUnique({
      where: { enrollmentId_assignmentId: { enrollmentId, assignmentId } },
      select: {
        reference: true,
        status: true,
        revisionOpenUntil: true,
        versions: {
          orderBy: { number: 'asc' },
          select: {
            number: true,
            isLate: true,
            courseVersion: true,
            linkUrl: true,
            note: true,
            createdAt: true,
            files: {
              orderBy: { position: 'asc' },
              select: { file: { select: { id: true, originalName: true, contentType: true, sizeBytes: true } } },
            },
          },
        },
      },
    });
    if (!submission || submission.versions.length === 0) return null;

    return {
      reference: submission.reference,
      status: submission.status,
      revisionOpenUntil: submission.revisionOpenUntil,
      versions: submission.versions.map((version) => ({
        number: version.number,
        submittedAt: version.createdAt,
        isLate: version.isLate,
        courseVersion: version.courseVersion,
        linkUrl: version.linkUrl,
        note: version.note,
        files: version.files.map(({ file }) => ({
          id: file.id,
          name: file.originalName,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          url: this.storage.linkFor(file.id), // works for a few minutes, made fresh on every request
        })),
      })),
    };
  }

  // ----------------------------------------------------------------- helpers

  private async discard(saved: readonly StoredFileView[]): Promise<void> {
    for (const file of saved) {
      try {
        await this.storage.remove(file.id);
      } catch {
        // Best effort: a leftover file nobody refers to is harmless and can be swept later.
      }
    }
  }
}
