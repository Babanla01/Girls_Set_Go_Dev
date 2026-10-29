/**
 * applications.service.ts
 * ---------------------------------------------------------------------------
 * How admins review student applications.
 *
 *  ACCEPT is ONE all-or-nothing database transaction:
 *     mark the application accepted + record who/when + create the enrollment
 *     (which is what unlocks the course) + write the audit entry + queue the
 *     acceptance email. If any step fails, none of them happen.
 *  Pressing Accept twice is SAFE: the second press finds the application
 *  already accepted into that same cohort and simply returns the same result
 *  (still exactly one enrollment, and no second email).
 *  Two safety locks stop real-life races:
 *     - the COHORT is locked while seats are counted, so two admins accepting
 *       two girls into the last seat cannot both succeed;
 *     - an application is "claimed" in one atomic step, so two admins deciding
 *       the same application cannot both succeed.
 *  Decisions email the student AND, when a guardian is on file, send a copy to
 *  the guardian. Every email is linked to the application, so a failed one
 *  shows on it and can be retried safely.
 *  Nothing is deleted. Every decision is audited (with the previous and the
 *  new status); no personal details go into the audit log.
 */
import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, ApplicationStatus, CohortStatus, CourseStatus, EmailStatus, EnrollmentStatus, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { renderEmail } from '../../common/email/email.templates';
import { OutboxEmail, OutboxService } from '../../common/outbox/outbox.service';
import { buildPage, Paginated, toSkipTake } from '../../common/pagination/pagination';
import type { Env } from '../../config/env.validation';
import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { formatCalendarDate, todayInProgrammeZone } from '../../catalog/catalog.util';
import { cohortSelect, toCohortView } from '../../catalog/cohort.view';
import { lockCohort } from '../../catalog/row-lock';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isRemovedAccountEmail,
  REMOVED_ACCOUNT_EMAIL_DOMAIN,
  REMOVED_REOPEN_MESSAGE,
} from '../../retention/retention.constants';
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
import type { PreviewDeclineDto } from './dto/preview-decline.dto';

const ALREADY_DECIDED = 'This application has already been decided.';

/** How an application is named when emails and audit entries point back at it. */
const APPLICATION_ENTITY = 'student_application';

/** The student, as far as emails are concerned (plus her guardian, when one is on file). */
interface StudentContact {
  fullName: string;
  email: string;
  studentProfile: { guardianName: string | null; guardianEmail: string | null } | null;
}

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

  /** Everything she submitted, plus how her emails went and who did what to the application. */
  async getOne(id: string) {
    const row = await this.prisma.studentApplication.findUnique({ where: { id }, select: applicationDetailSelect });
    if (!row) throw new NotFoundException('Application not found.');

    const [emails, auditTrail] = await Promise.all([
      this.emailsOf(id, row.student.email),
      this.prisma.auditLog.findMany({
        where: { entityType: APPLICATION_ENTITY, entityId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
        select: {
          action: true,
          actorRole: true,
          createdAt: true,
          previousValue: true,
          newValue: true,
          actor: { select: { id: true, fullName: true } },
        },
      }),
    ]);

    return { application: { ...toApplicationDetail(row, todayInProgrammeZone()), emails, auditTrail } };
  }

  // ------------------------------------------------------------------ accept

  async accept(admin: AuthenticatedUser, id: string, dto: AcceptApplicationDto, context: RequestContext) {
    try {
      const { enrollment, cohortId, emails } = await this.prisma.$transaction(async (tx) => {
        // Take turns with anyone else accepting into (or archiving) this cohort.
        await lockCohort(tx, dto.cohortId);

        const application = await tx.studentApplication.findUnique({
          where: { id },
          select: {
            status: true,
            enrollment: { select: { id: true, reference: true, enrolledAt: true, cohortId: true, status: true } },
            student: {
              select: {
                id: true,
                fullName: true,
                email: true,
                status: true,
                studentProfile: { select: { guardianName: true, guardianEmail: true } },
              },
            },
          },
        });
        if (!application) throw new NotFoundException('Application not found.');

        // A repeated click (or a retry after a slow network): already accepted into
        // THIS cohort and still enrolled -> return the same result, change nothing.
        if (
          application.status === ApplicationStatus.ACCEPTED &&
          application.enrollment?.status === EnrollmentStatus.ACTIVE &&
          application.enrollment.cohortId === dto.cohortId
        ) {
          const existing = application.enrollment;
          return {
            enrollment: { id: existing.id, reference: existing.reference, enrolledAt: existing.enrolledAt },
            cohortId: dto.cohortId,
            emails: [] as OutboxEmail[],
          };
        }
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
        if (cohort.status === CohortStatus.CLOSED) {
          throw new ConflictException('Students cannot be accepted into a closed cohort.');
        }
        if (cohort.course.status === CourseStatus.ARCHIVED) {
          throw new ConflictException('Students cannot be accepted into a cohort of an archived course.');
        }

        // Is there a seat left? (Safe: the cohort is locked, so nobody else can take it meanwhile.)
        if (cohort.capacity !== null) {
          const taken = await tx.enrollment.count({ where: { cohortId: cohort.id, status: EnrollmentStatus.ACTIVE } });
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
          select: { id: true, reference: true, enrolledAt: true },
        });

        // The student's email, plus a copy for her guardian when one is on file.
        const emails = this.buildEmails(id, 'application-accepted', application.student, {
          trackName: cohort.course.track.name,
          courseTitle: cohort.course.title,
          cohortName: cohort.name,
          startsOn: formatCalendarDate(cohort.startsOn),
          endsOn: formatCalendarDate(cohort.endsOn),
          actionUrl: this.loginUrl(),
        });
        for (const message of emails) await this.outbox.enqueue(message, tx);

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
            previousValue: { status: ApplicationStatus.PENDING },
            newValue: { status: ApplicationStatus.ACCEPTED, cohortId: cohort.id, enrollmentId: enrollment.id },
            ipAddress: context.ipAddress,
          },
          tx,
        );

        return { enrollment, cohortId: cohort.id, emails };
      });

      for (const email of emails) this.outbox.previewInDevelopment(email); // none on a repeated click: no second email

      const [application, cohort] = await Promise.all([
        this.prisma.studentApplication.findUniqueOrThrow({ where: { id }, select: applicationListSelect }),
        this.prisma.cohort.findUniqueOrThrow({ where: { id: cohortId }, select: cohortSelect }),
      ]);
      return {
        application: toApplicationSummary(application),
        enrollment: {
          id: enrollment.id,
          reference: enrollment.reference,
          enrolledAt: enrollment.enrolledAt,
          cohort: toCohortView(cohort, todayInProgrammeZone()),
        },
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

  /**
   * Shows the email a decline WOULD send, without sending or saving anything, so
   * the admin can read it (including her personal note) first. Also tells her
   * whether a copy would go to the guardian.
   */
  async previewDecline(id: string, dto: PreviewDeclineDto) {
    const application = await this.prisma.studentApplication.findUnique({
      where: { id },
      select: {
        status: true,
        student: {
          select: {
            fullName: true,
            email: true,
            studentProfile: { select: { guardianName: true, guardianEmail: true } },
          },
        },
      },
    });
    if (!application) throw new NotFoundException('Application not found.');
    if (application.status !== ApplicationStatus.PENDING) throw new ConflictException(ALREADY_DECIDED);

    const [studentEmail, guardianEmail] = this.buildEmails(id, 'application-declined', application.student, {
      ...(dto.personalNote ? { personalNote: dto.personalNote } : {}),
    });
    const rendered = renderEmail(studentEmail.template, studentEmail.payload);
    if (!rendered) throw new InternalServerErrorException('The email preview could not be built.');

    return {
      preview: { toEmail: studentEmail.toEmail, subject: rendered.subject, text: rendered.text, html: rendered.html },
      guardianCopyTo: guardianEmail?.toEmail ?? null,
    };
  }

  async decline(
    admin: AuthenticatedUser,
    id: string,
    dto: DeclineApplicationDto,
    context: RequestContext,
  ): Promise<{ application: ApplicationSummary }> {
    const emails = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.studentApplication.updateMany({
        where: { id, status: ApplicationStatus.PENDING },
        data: {
          status: ApplicationStatus.DECLINED,
          reviewedById: admin.id,
          reviewedAt: new Date(),
          decisionNote: null,
          declineReason: dto.reason, // internal, for reporting only
          personalNote: dto.personalNote ?? null, // goes into the email
        },
      });
      if (claimed.count !== 1) await this.explainFailedDecision(tx, id);

      const { student } = await tx.studentApplication.findUniqueOrThrow({
        where: { id },
        select: {
          student: {
            select: {
              id: true,
              fullName: true,
              email: true,
              studentProfile: { select: { guardianName: true, guardianEmail: true } },
            },
          },
        },
      });

      // The student's email (with her personal note, never the internal reason),
      // plus a copy for her guardian when one is on file.
      const queued = this.buildEmails(id, 'application-declined', student, {
        ...(dto.personalNote ? { personalNote: dto.personalNote } : {}),
      });
      for (const message of queued) await this.outbox.enqueue(message, tx);

      await this.audit.record(
        {
          actorId: admin.id,
          action: 'application.declined',
          entityType: APPLICATION_ENTITY,
          entityId: id,
          metadata: { studentId: student.id },
          previousValue: { status: ApplicationStatus.PENDING },
          newValue: { status: ApplicationStatus.DECLINED, reason: dto.reason }, // the reason is a fixed code, not text she wrote
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return queued;
    });

    for (const email of emails) this.outbox.previewInDevelopment(email);
    return { application: await this.summaryOf(id) };
  }

  // ------------------------------------------------------------------ reopen

  /**
   * A declined application can go back to pending (for example after a mistake) -
   * unless the applicant's personal data has already been removed (two months
   * after the decision), because there is nothing left to review.
   */
  async reopen(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ application: ApplicationSummary }> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.studentApplication.findUnique({ where: { id }, select: { declineReason: true } });

      const reopened = await tx.studentApplication.updateMany({
        where: {
          id,
          status: ApplicationStatus.DECLINED,
          student: { NOT: { email: { endsWith: `@${REMOVED_ACCOUNT_EMAIL_DOMAIN}` } } },
        },
        data: {
          status: ApplicationStatus.PENDING,
          reviewedById: null,
          reviewedAt: null,
          decisionNote: null,
          declineReason: null,
          personalNote: null,
        },
      });
      if (reopened.count !== 1) {
        const row = await tx.studentApplication.findUnique({
          where: { id },
          select: { status: true, student: { select: { email: true } } },
        });
        if (!row) throw new NotFoundException('Application not found.');
        if (row.status === ApplicationStatus.DECLINED && isRemovedAccountEmail(row.student.email)) {
          throw new ConflictException(REMOVED_REOPEN_MESSAGE);
        }
        throw new ConflictException('Only declined applications can be reopened.');
      }

      await this.audit.record(
        {
          actorId: admin.id,
          action: 'application.reopened',
          entityType: APPLICATION_ENTITY,
          entityId: id,
          previousValue: { status: ApplicationStatus.DECLINED, reason: before?.declineReason ?? null },
          newValue: { status: ApplicationStatus.PENDING },
          ipAddress: context.ipAddress,
        },
        tx,
      );
    });
    return { application: await this.summaryOf(id) };
  }

  // ------------------------------------------------------------------ emails

  /** Applications that have at least one email that could not be delivered (for the dashboard warning). */
  async listEmailFailures() {
    const failed = await this.prisma.emailOutbox.findMany({
      where: { entityType: APPLICATION_ENTITY, status: EmailStatus.FAILED },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 200,
      select: { entityId: true, template: true, lastError: true, createdAt: true },
    });

    const ids = [...new Set(failed.map((row) => row.entityId).filter((value): value is string => value !== null))];
    const applications = await this.prisma.studentApplication.findMany({
      where: { id: { in: ids } },
      select: { id: true, reference: true, student: { select: { fullName: true } } },
    });

    return {
      failedEmailCount: failed.length,
      applications: applications.map((application) => ({
        id: application.id,
        reference: application.reference,
        studentName: application.student.fullName,
        failedEmails: failed
          .filter((row) => row.entityId === application.id)
          .map((row) => ({ template: row.template, error: row.lastError, failedAt: row.createdAt })),
      })),
    };
  }

  /**
   * Re-queues this application's FAILED emails (each gets a fresh set of attempts).
   * Safe to press twice: emails that are pending or already sent are never touched.
   */
  async retryEmails(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<{ retried: number }> {
    const exists = await this.prisma.studentApplication.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Application not found.');

    const retried = await this.prisma.$transaction(async (tx) => {
      const count = await this.outbox.retryFailed(APPLICATION_ENTITY, id, tx);
      if (count > 0) {
        await this.audit.record(
          {
            actorId: admin.id,
            action: 'application.emails_retried',
            entityType: APPLICATION_ENTITY,
            entityId: id,
            metadata: { count },
            ipAddress: context.ipAddress,
          },
          tx,
        );
      }
      return count;
    });

    if (retried === 0) throw new ConflictException('There are no failed emails to retry for this application.');
    return { retried };
  }

  // ----------------------------------------------------------------- helpers

  /** How this application's emails went (no stored values - those are wiped once sent). */
  private async emailsOf(applicationId: string, studentEmail: string) {
    const rows = await this.prisma.emailOutbox.findMany({
      where: { entityType: APPLICATION_ENTITY, entityId: applicationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, template: true, toEmail: true, status: true, attempts: true, lastError: true, sentAt: true, createdAt: true },
    });
    return rows.map((row) => ({
      ...row,
      recipient: row.toEmail === studentEmail ? ('student' as const) : ('guardian' as const),
    }));
  }

  /**
   * The student's email and, when a guardian is on file (and her address is not
   * the student's own), a copy for the guardian worded for her. Both are linked
   * to the application, so a failed one shows on it and can be retried.
   */
  private buildEmails(
    applicationId: string,
    template: string,
    student: StudentContact,
    payload: Prisma.InputJsonObject,
  ): OutboxEmail[] {
    const link = { entityType: APPLICATION_ENTITY, entityId: applicationId };
    const emails: OutboxEmail[] = [
      { toEmail: student.email, template, payload: { ...payload, fullName: student.fullName }, ...link },
    ];

    const guardianName = student.studentProfile?.guardianName;
    const guardianEmail = student.studentProfile?.guardianEmail;
    if (guardianName && guardianEmail && guardianEmail !== student.email) {
      emails.push({
        toEmail: guardianEmail,
        template,
        payload: { ...payload, fullName: guardianName, studentName: student.fullName, guardianCopy: true },
        ...link,
      });
    }
    return emails;
  }

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