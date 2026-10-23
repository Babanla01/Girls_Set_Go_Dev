/**
 * applications.service.ts
 * ---------------------------------------------------------------------------
 * How admins review student applications.
 *
 *  ACCEPT is ONE all-or-nothing database transaction:
 *     mark the application accepted + record who/when + create the enrollment
 *     (which is what unlocks the course) + write the audit entry + queue the
 *     acceptance email. If any step fails, none of them happen.
 *  Two safety locks stop real-life races:
 *     - the COHORT is locked while seats are counted, so two admins accepting
 *       two girls into the last seat cannot both succeed;
 *     - an application is "claimed" in one atomic step, so two admins deciding
 *       the same application cannot both succeed.
 *  Nothing is deleted. Every decision is audited; no personal details go into
 *  the audit log.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, ApplicationStatus, CohortStatus, CourseStatus, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { OutboxEmail, OutboxService } from '../../common/outbox/outbox.service';
import { buildPage, Paginated, toSkipTake } from '../../common/pagination/pagination';
import type { Env } from '../../config/env.validation';
import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { formatCalendarDate, todayInProgrammeZone } from '../../catalog/catalog.util';
import { cohortSelect, toCohortView } from '../../catalog/cohort.view';
import { lockCohort } from '../../catalog/row-lock';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ApplicationSummary,
  applicationDetailSelect,
  applicationListSelect,
  toApplicationDetail,
  toApplicationSummary,
} from './application.view';
import type { AcceptApplicationDto } from './dto/accept-application.dto';
import type { DeclineApplicationDto } from './dto/decline-application.dto';
import type { ListApplicationsQuery } from './dto/list-applications.query';

const ALREADY_DECIDED = 'This application has already been decided.';

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // -------------------------------------------------------------------- list

  async list(query: ListApplicationsQuery): Promise<Paginated<ApplicationSummary>> {
    const where: Prisma.StudentApplicationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.preferredTrackId ? { preferredTrackId: query.preferredTrackId } : {}),
      ...(query.from || query.to
        ? { submittedAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.search
        ? {
            student: {
              OR: [
                { fullName: { contains: query.search, mode: 'insensitive' } },
                { email: { contains: query.search.toLowerCase() } },
              ],
            },
          }
        : {}),
    };

    const orderBy: Prisma.StudentApplicationOrderByWithRelationInput[] =
      query.sortBy === 'name'
        ? [{ student: { fullName: query.sortDir } }, { id: 'asc' }]
        : [{ submittedAt: query.sortDir }, { id: 'asc' }];

    const [total, rows] = await Promise.all([
      this.prisma.studentApplication.count({ where }),
      this.prisma.studentApplication.findMany({ where, orderBy, ...toSkipTake(query), select: applicationListSelect }),
    ]);

    return buildPage(rows.map(toApplicationSummary), total, query);
  }

  // ------------------------------------------------------------------ detail

  async getOne(id: string) {
    const row = await this.prisma.studentApplication.findUnique({ where: { id }, select: applicationDetailSelect });
    if (!row) throw new NotFoundException('Application not found.');
    return { application: toApplicationDetail(row, todayInProgrammeZone()) };
  }

  // ------------------------------------------------------------------ accept

  async accept(admin: AuthenticatedUser, id: string, dto: AcceptApplicationDto, context: RequestContext) {
    try {
      const { enrollment, cohortId, email } = await this.prisma.$transaction(async (tx) => {
        // Take turns with anyone else accepting into (or archiving) this cohort.
        await lockCohort(tx, dto.cohortId);

        const application = await tx.studentApplication.findUnique({
          where: { id },
          select: { status: true, student: { select: { id: true, fullName: true, email: true, status: true } } },
        });
        if (!application) throw new NotFoundException('Application not found.');
        if (application.status !== ApplicationStatus.PENDING) throw new ConflictException(ALREADY_DECIDED);
        if (application.student.status === AccountStatus.SUSPENDED) {
          throw new ConflictException("This student's account is suspended, so she cannot be accepted.");
        }

        const cohort = await tx.cohort.findUnique({
          where: { id: dto.cohortId },
          select: {
            id: true,
            name: true,
            status: true,
            capacity: true,
            startsOn: true,
            endsOn: true,
            course: { select: { id: true, title: true, status: true, track: { select: { id: true, name: true } } } },
          },
        });
        if (!cohort) throw new NotFoundException('Cohort not found.');
        if (cohort.status === CohortStatus.ARCHIVED) {
          throw new ConflictException('Students cannot be accepted into an archived cohort.');
        }
        if (cohort.course.status === CourseStatus.ARCHIVED) {
          throw new ConflictException('Students cannot be accepted into a cohort of an archived course.');
        }

        // Is there a seat left? (Safe: the cohort is locked, so nobody else can take it meanwhile.)
        if (cohort.capacity !== null) {
          const taken = await tx.enrollment.count({ where: { cohortId: cohort.id, status: 'ACTIVE' } });
          if (taken >= cohort.capacity) throw new ConflictException('This cohort is full.');
        }

        // Claim the application in ONE atomic step: if someone decided it a
        // moment ago, this finds nothing to update and we stop.
        const claimed = await tx.studentApplication.updateMany({
          where: { id, status: ApplicationStatus.PENDING },
          data: {
            status: ApplicationStatus.ACCEPTED,
            reviewedById: admin.id,
            reviewedAt: new Date(),
            decisionNote: dto.note?.trim() || null,
          },
        });
        if (claimed.count !== 1) throw new ConflictException(ALREADY_DECIDED);

        // The enrollment is what unlocks the course.
        const enrollment = await tx.enrollment.create({
          data: { studentId: application.student.id, cohortId: cohort.id, applicationId: id, createdById: admin.id },
          select: { id: true, enrolledAt: true },
        });

        const message: OutboxEmail = {
          toEmail: application.student.email,
          template: 'application-accepted',
          payload: {
            fullName: application.student.fullName,
            trackName: cohort.course.track.name,
            courseTitle: cohort.course.title,
            cohortName: cohort.name,
            startsOn: formatCalendarDate(cohort.startsOn),
            endsOn: formatCalendarDate(cohort.endsOn),
            actionUrl: this.loginUrl(),
          },
        };
        await this.outbox.enqueue(message, tx);

        await this.audit.record(
          {
            actorId: admin.id,
            action: 'application.accepted',
            entityType: 'student_application',
            entityId: id,
            metadata: {
              studentId: application.student.id,
              cohortId: cohort.id,
              courseId: cohort.course.id,
              trackId: cohort.course.track.id,
            },
            ipAddress: context.ipAddress,
          },
          tx,
        );

        return { enrollment, cohortId: cohort.id, email: message };
      });

      this.outbox.previewInDevelopment(email);

      const [application, cohort] = await Promise.all([
        this.prisma.studentApplication.findUniqueOrThrow({ where: { id }, select: applicationListSelect }),
        this.prisma.cohort.findUniqueOrThrow({ where: { id: cohortId }, select: cohortSelect }),
      ]);
      return {
        application: toApplicationSummary(application),
        enrollment: { id: enrollment.id, enrolledAt: enrollment.enrolledAt, cohort: toCohortView(cohort, todayInProgrammeZone()) },
      };
    } catch (error) {
      // The database allows only ONE active enrollment per student.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This student is already enrolled in a cohort.');
      }
      throw error;
    }
  }

  // ----------------------------------------------------------------- decline

  async decline(
    admin: AuthenticatedUser,
    id: string,
    dto: DeclineApplicationDto,
    context: RequestContext,
  ): Promise<{ application: ApplicationSummary }> {
    const message = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.studentApplication.updateMany({
        where: { id, status: ApplicationStatus.PENDING },
        data: {
          status: ApplicationStatus.DECLINED,
          reviewedById: admin.id,
          reviewedAt: new Date(),
          decisionNote: dto.note?.trim() || null,
        },
      });
      if (claimed.count !== 1) await this.explainFailedDecision(tx, id);

      const student = await tx.studentApplication.findUniqueOrThrow({
        where: { id },
        select: { student: { select: { id: true, fullName: true, email: true } } },
      });

      // The standard decision email carries NO reason: the private note stays private.
      const email: OutboxEmail = {
        toEmail: student.student.email,
        template: 'application-declined',
        payload: { fullName: student.student.fullName },
      };
      await this.outbox.enqueue(email, tx);

      await this.audit.record(
        {
          actorId: admin.id,
          action: 'application.declined',
          entityType: 'student_application',
          entityId: id,
          metadata: { studentId: student.student.id },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return email;
    });

    this.outbox.previewInDevelopment(message);
    return { application: await this.summaryOf(id) };
  }

  // ------------------------------------------------------------------ reopen

  /** A declined application can go back to pending (for example after a mistake). */
  async reopen(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ application: ApplicationSummary }> {
    await this.prisma.$transaction(async (tx) => {
      const reopened = await tx.studentApplication.updateMany({
        where: { id, status: ApplicationStatus.DECLINED },
        data: { status: ApplicationStatus.PENDING, reviewedById: null, reviewedAt: null, decisionNote: null },
      });
      if (reopened.count !== 1) {
        const exists = await tx.studentApplication.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw new NotFoundException('Application not found.');
        throw new ConflictException('Only declined applications can be reopened.');
      }

      await this.audit.record(
        { actorId: admin.id, action: 'application.reopened', entityType: 'student_application', entityId: id, ipAddress: context.ipAddress },
        tx,
      );
    });
    return { application: await this.summaryOf(id) };
  }

  // ----------------------------------------------------------------- helpers

  private async summaryOf(id: string): Promise<ApplicationSummary> {
    return toApplicationSummary(await this.prisma.studentApplication.findUniqueOrThrow({ where: { id }, select: applicationListSelect }));
  }

  /** A decision matched nothing: either the application does not exist, or it was already decided. */
  private async explainFailedDecision(tx: Prisma.TransactionClient, id: string): Promise<never> {
    const exists = await tx.studentApplication.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Application not found.');
    throw new ConflictException(ALREADY_DECIDED);
  }

  private loginUrl(): string {
    return `${this.config.get('APP_URL', { infer: true }).replace(/\/+$/, '')}/login`;
  }
}