/**
 * students.service.ts
 * ---------------------------------------------------------------------------
 * The student's side of admissions: signing up and applying, confirming the
 * email address, and the dashboard that shows where she stands.
 *
 * Principles:
 *  - SIGNUP IS ALL-OR-NOTHING: the account, the profile, the application, the
 *    confirmation link and the queued emails are saved in ONE transaction.
 *  - COURSE ACCESS COMES FROM AN ENROLLMENT, never from a flag: the dashboard
 *    says "unlocked" only when she has an active enrollment in an active cohort.
 *  - PERSONAL DETAILS STAY PRIVATE: dates of birth, phone numbers and guardian
 *    details never go into the audit log or any list.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { AccountStatus, AuthTokenType, Prisma, Role, TrackStatus } from '@prisma/client';

import { AuditService } from '../common/audit/audit.service';
import { OutboxEmail, OutboxService } from '../common/outbox/outbox.service';
import type { DbClient } from '../common/types/db-client';
import { normalizeEmail } from '../common/utils/normalize-email';
import { INVALID_LINK_ERROR } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { PasswordService } from '../auth/password/password.service';
import { SessionService } from '../auth/session.service';
import { TokenService } from '../auth/token.service';
import { parseCalendarDate, todayInProgrammeZone } from '../catalog/catalog.util';
import { cohortSelect, toCohortView } from '../catalog/cohort.view';
import { PrismaService } from '../prisma/prisma.service';
import { ageOnDate } from './age';
import type { RegisterStudentDto } from './dto/register-student.dto';
import {
  ADULT_AGE,
  CONSENT_VERSION,
  DASHBOARD_MESSAGES,
  DUPLICATE_EMAIL_MESSAGE,
  GUARDIAN_CONSENT_REQUIRED_MESSAGE,
  GUARDIAN_PARTIAL_MESSAGE,
  GUARDIAN_REQUIRED_MESSAGE,
  MAX_PLAUSIBLE_AGE,
  PASSWORDS_DIFFER_MESSAGE,
  UNKNOWN_TRACK_MESSAGE,
} from './students.constants';

export type RegistrationResult =
  | { trapped: true }
  | {
      trapped: false;
      sessionToken: string;
      user: AuthenticatedUser;
      application: { status: 'PENDING'; submittedAt: Date };
      emailVerified: false;
    };

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ---------------------------------------------------------------- register

  async register(dto: RegisterStudentDto, context: RequestContext): Promise<RegistrationResult> {
    // 0) The hidden bot-trap field: a real person never fills it in. Pretend it
    //    worked (so the bot learns nothing) but save nothing.
    if (dto.website && dto.website.trim() !== '') {
      await this.audit.record({
        action: 'student.signup_trap_triggered',
        entityType: 'student',
        ipAddress: context.ipAddress,
      });
      return { trapped: true };
    }

    // 1) Rules that involve several fields at once.
    if (dto.password !== dto.confirmPassword) throw new BadRequestException(PASSWORDS_DIFFER_MESSAGE);
    const problems = this.passwords.validatePolicy(dto.password);
    if (problems.length > 0) throw new BadRequestException(problems);

    const today = todayInProgrammeZone();
    if (dto.dateOfBirth > today) throw new BadRequestException('The date of birth cannot be in the future.');
    const age = ageOnDate(dto.dateOfBirth, today);
    if (age > MAX_PLAUSIBLE_AGE) throw new BadRequestException('Please check the date of birth.');

    const isMinor = age < ADULT_AGE;
    const guardianGiven = [dto.guardianName, dto.guardianEmail, dto.guardianPhone].filter(Boolean).length;

    if (isMinor && guardianGiven < 3) throw new BadRequestException(GUARDIAN_REQUIRED_MESSAGE);
    if (isMinor && dto.guardianConsent !== true) throw new BadRequestException(GUARDIAN_CONSENT_REQUIRED_MESSAGE);
    if (!isMinor && guardianGiven > 0 && guardianGiven < 3) throw new BadRequestException(GUARDIAN_PARTIAL_MESSAGE);

    // 2) Hash the password BEFORE the transaction (it is deliberately slow, and
    //    we do not want to hold a database transaction open while it runs).
    const passwordHash = await this.passwords.hash(dto.password);
    const email = normalizeEmail(dto.email);
    const now = new Date();

    try {
      const { user, application, queued } = await this.prisma.$transaction(async (tx) => {
        const track = await tx.track.findUnique({
          where: { id: dto.preferredTrackId },
          select: { id: true, name: true, status: true },
        });
        if (!track || track.status !== TrackStatus.ACTIVE) throw new BadRequestException(UNKNOWN_TRACK_MESSAGE);

        const user = await tx.user.create({
          data: { email, fullName: dto.fullName, role: Role.STUDENT, status: AccountStatus.ACTIVE, passwordHash },
          select: { id: true, email: true, fullName: true, role: true },
        });

        await tx.studentProfile.create({
          data: {
            userId: user.id,
            dateOfBirth: parseCalendarDate(dto.dateOfBirth),
            phone: dto.phone,
            location: dto.location,
            schoolName: dto.schoolName,
            gradeLevel: dto.gradeLevel,
            guardianName: dto.guardianName ?? null,
            guardianEmail: dto.guardianEmail ?? null,
            guardianPhone: dto.guardianPhone ?? null,
          },
        });

        const application = await tx.studentApplication.create({
          data: {
            studentId: user.id,
            preferredTrackId: track.id,
            whyJoin: dto.whyJoin,
            hopeToLearn: dto.hopeToLearn,
            stemExperience: dto.stemExperience ?? null,
            consentAcceptedAt: now,
            guardianConsentAt: dto.guardianConsent === true ? now : null,
            consentVersion: CONSENT_VERSION,
          },
          select: { status: true, submittedAt: true },
        });

        // Two emails go to the outbox (sent by the email worker in a later batch).
        const queued: OutboxEmail[] = [
          await this.queueVerification(tx, user),
          { toEmail: user.email, template: 'application-received', payload: { fullName: user.fullName, preferredTrack: track.name } },
        ];
        await this.outbox.enqueue(queued[1], tx);

        // The audit entry holds NO personal details - only ids and a yes/no.
        await this.audit.record(
          {
            actorId: user.id,
            action: 'student.registered',
            entityType: 'student',
            entityId: user.id,
            metadata: { preferredTrackId: track.id, minor: isMinor },
            ipAddress: context.ipAddress,
          },
          tx,
        );

        return { user, application, queued };
      });

      this.outbox.previewInDevelopment(queued[0]); // dev only: print the confirmation link

      // Sign her in straight away so she lands on the "pending" dashboard.
      const sessionToken = await this.sessions.create(user.id, context);

      return {
        trapped: false,
        sessionToken,
        user,
        application: { status: 'PENDING', submittedAt: application.submittedAt },
        emailVerified: false,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(DUPLICATE_EMAIL_MESSAGE);
      }
      throw error;
    }
  }

  // ----------------------------------------------------------- verify email

  /** Uses the emailed link to mark the address as confirmed. */
  async verifyEmail(token: string, context: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const userId = await this.tokens.claim(token, AuthTokenType.EMAIL_VERIFICATION, tx);
      if (!userId) throw new BadRequestException(INVALID_LINK_ERROR);

      await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
      await this.audit.record(
        { actorId: userId, action: 'student.email_verified', entityType: 'student', entityId: userId, ipAddress: context.ipAddress },
        tx,
      );
    });
  }

  /** Sends a fresh confirmation link (the older one stops working). */
  async resendVerification(user: AuthenticatedUser, context: RequestContext): Promise<void> {
    const message = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { emailVerifiedAt: true } });
      if (current.emailVerifiedAt) throw new ConflictException('Your email address is already confirmed.');

      const queued = await this.queueVerification(tx, user);
      await this.audit.record(
        { actorId: user.id, action: 'student.verification_resent', entityType: 'student', entityId: user.id, ipAddress: context.ipAddress },
        tx,
      );
      return queued;
    });
    this.outbox.previewInDevelopment(message);
  }

  // --------------------------------------------------------------- dashboard

  /** Where does this student stand? Application status, and whether the course is unlocked. */
  async dashboard(user: AuthenticatedUser) {
    const today = todayInProgrammeZone();

    const [account, application, enrollment] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { id: true, fullName: true, email: true, emailVerifiedAt: true },
      }),
      this.prisma.studentApplication.findUnique({
        where: { studentId: user.id },
        select: {
          status: true,
          submittedAt: true,
          reviewedAt: true, // the decision DATE only - the private note is never selected
          preferredTrack: { select: { id: true, name: true } },
        },
      }),
      this.prisma.enrollment.findFirst({
        where: { studentId: user.id, status: 'ACTIVE' },
        select: { enrolledAt: true, cohort: { select: cohortSelect } },
      }),
    ]);

    const cohort = enrollment ? toCohortView(enrollment.cohort, today) : null;
    // Unlocked only with an active enrollment in a cohort that is still active.
    const unlocked = cohort !== null && cohort.status === 'ACTIVE';

    const message = unlocked
      ? DASHBOARD_MESSAGES.accepted
      : !application
        ? DASHBOARD_MESSAGES.none
        : application.status === 'DECLINED'
          ? DASHBOARD_MESSAGES.declined
          : DASHBOARD_MESSAGES.pending;

    return {
      student: {
        id: account.id,
        fullName: account.fullName,
        email: account.email,
        emailVerified: account.emailVerifiedAt !== null,
      },
      application: application
        ? {
            status: application.status,
            submittedAt: application.submittedAt,
            decidedAt: application.reviewedAt,
            preferredTrack: application.preferredTrack,
          }
        : null,
      enrollment: enrollment && cohort ? { enrolledAt: enrollment.enrolledAt, cohort } : null,
      courseAccess: unlocked ? ('unlocked' as const) : ('locked' as const),
      message,
    };
  }

  // ----------------------------------------------------------------- helpers

  /** Makes a confirmation link (voiding any older one) and queues the email. Runs inside a transaction. */
  private async queueVerification(
    db: DbClient,
    user: { id: string; email: string; fullName: string },
  ): Promise<OutboxEmail> {
    const token = await this.tokens.issue(user.id, AuthTokenType.EMAIL_VERIFICATION, db);
    const message: OutboxEmail = {
      toEmail: user.email,
      template: 'verify-email',
      payload: { fullName: user.fullName, actionUrl: this.auth.buildLink('verify-email', token) },
    };
    await this.outbox.enqueue(message, db);
    return message;
  }
}