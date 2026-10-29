/**
 * student-management.service.ts  (admin side)
 * ---------------------------------------------------------------------------
 * What an admin may DO to a student: edit her details, suspend / reactivate
 * her account, withdraw her from her cohort, or move her to another cohort.
 *
 * Rules that hold throughout:
 *   - Only accounts with the STUDENT role are ever touched (anything else
 *     looks like "not found").
 *   - Every change happens in ONE all-or-nothing transaction together with its
 *     audit entry. Audit entries hold ids and field NAMES only - never a
 *     student's name, email, phone or any value she gave.
 *   - Seat changes (move, withdraw) take the same cohort locks as accepting a
 *     student, so they can never race with an acceptance. When two cohorts are
 *     locked they are locked in a fixed order (by id), so two admins moving
 *     students in opposite directions can never wait on each other forever.
 *   - A student whose personal data has been removed (see the retention job)
 *     can no longer be edited, moved or reactivated.
 *   - Nothing is deleted: a withdrawn or moved student keeps her history.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountStatus, CohortStatus, CourseStatus, Prisma, Role } from '@prisma/client';

const EnrollmentStatus = {
  ACTIVE: 'ACTIVE',
  WITHDRAWN: 'WITHDRAWN',
  TRANSFERRED: 'TRANSFERRED',
} as const;

import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { SessionService } from '../../auth/session.service';
import { formatCalendarDate, todayInProgrammeZone } from '../../catalog/catalog.util';
import { lockCohort } from '../../catalog/row-lock';
import { AuditService } from '../../common/audit/audit.service';
import type { DbClient } from '../../common/types/db-client';
import { PrismaService } from '../../prisma/prisma.service';
import { isRemovedAccountEmail, REMOVED_ACCOUNT_MESSAGE } from '../../retention/retention.constants';
import { ageOnDate } from '../../students/age';
import { ADULT_AGE, GUARDIAN_PARTIAL_MESSAGE, GUARDIAN_REQUIRED_MESSAGE } from '../../students/students.constants';
import type { MoveStudentDto } from './dto/move-student.dto';
import type { UpdateStudentDto } from './dto/update-student.dto';
import { studentDetailSelect, toStudentDetail } from './student.view';

export const NOT_ENROLLED_MESSAGE = 'This student is not enrolled in a cohort.';

type StudentDetailResult = { student: ReturnType<typeof toStudentDetail> };

@Injectable()
export class StudentManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  // -------------------------------------------------------------------- edit

  async update(
    admin: AuthenticatedUser,
    id: string,
    dto: UpdateStudentDto,
    context: RequestContext,
  ): Promise<StudentDetailResult> {
    if (!Object.values(dto).some((value) => value !== undefined)) {
      throw new BadRequestException('Nothing to update.');
    }

    return this.prisma.$transaction(async (tx) => {
      const student = await this.findStudent(tx, id);
      if (isRemovedAccountEmail(student.email)) throw new ConflictException(REMOVED_ACCOUNT_MESSAGE);

      const profile = await tx.studentProfile.findUnique({ where: { userId: id } });
      if (!profile) throw new ConflictException('This student has no profile to edit.');

      const changed: string[] = [];
      const profileData: Prisma.StudentProfileUpdateInput = {};
      let newFullName: string | undefined;

      if (dto.fullName !== undefined && dto.fullName !== student.fullName) {
        newFullName = dto.fullName;
        changed.push('fullName');
      }

      for (const field of ['phone', 'city', 'state', 'schoolName', 'gradeLevel'] as const) {
        const value = dto[field];
        if (value !== undefined && value !== profile[field]) {
          profileData[field] = value;
          changed.push(field);
        }
      }

      // Guardian: work out how it WOULD look, then check the rules on the whole.
      const guardianSent =
        dto.guardianName !== undefined || dto.guardianEmail !== undefined || dto.guardianPhone !== undefined;
      if (guardianSent) {
        const next = {
          guardianName: dto.guardianName === undefined ? profile.guardianName : dto.guardianName,
          guardianEmail: dto.guardianEmail === undefined ? profile.guardianEmail : dto.guardianEmail,
          guardianPhone: dto.guardianPhone === undefined ? profile.guardianPhone : dto.guardianPhone,
        };
        const given = [next.guardianName, next.guardianEmail, next.guardianPhone].filter((v) => v !== null).length;
        const age = ageOnDate(formatCalendarDate(profile.dateOfBirth), todayInProgrammeZone());

        if (age < ADULT_AGE && given !== 3) throw new BadRequestException(GUARDIAN_REQUIRED_MESSAGE);
        if (given !== 0 && given !== 3) throw new BadRequestException(GUARDIAN_PARTIAL_MESSAGE);

        const guardianChanged =
          next.guardianName !== profile.guardianName ||
          next.guardianEmail !== profile.guardianEmail ||
          next.guardianPhone !== profile.guardianPhone;
        if (guardianChanged) {
          profileData.guardianName = next.guardianName;
          profileData.guardianEmail = next.guardianEmail;
          profileData.guardianPhone = next.guardianPhone;
          changed.push('guardian');
        }
      }

      if (changed.length === 0) return this.detailOf(tx, id); // nothing really changed

      if (newFullName !== undefined) {
        await tx.user.update({ where: { id }, data: { fullName: newFullName } });
      }
      if (Object.keys(profileData).length > 0) {
        await tx.studentProfile.update({ where: { userId: id }, data: profileData });
      }

      await this.audit.record(
        {
          actorId: admin.id,
          action: 'student.updated',
          entityType: 'user',
          entityId: id,
          metadata: { changed }, // field NAMES only, never the values
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return this.detailOf(tx, id);
    });
  }

  // ------------------------------------------------------ suspend / reactivate

  async suspend(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<StudentDetailResult> {
    return this.prisma.$transaction(async (tx) => {
      const student = await this.findStudent(tx, id);
      if (student.status === AccountStatus.SUSPENDED) {
        throw new ConflictException('This student is already suspended.');
      }

      await tx.user.update({ where: { id }, data: { status: AccountStatus.SUSPENDED } });

      // Sign her out of every device RIGHT NOW (in the same transaction).
      await this.sessions.revokeAllForUser(id, tx);

      await this.audit.record(
        { actorId: admin.id, action: 'student.suspended', entityType: 'user', entityId: id, ipAddress: context.ipAddress },
        tx,
      );
      return this.detailOf(tx, id);
    });
  }

  async reactivate(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<StudentDetailResult> {
    return this.prisma.$transaction(async (tx) => {
      const student = await this.findStudent(tx, id);
      if (student.status !== AccountStatus.SUSPENDED) {
        throw new ConflictException('Only suspended students can be reactivated.');
      }
      if (isRemovedAccountEmail(student.email)) throw new ConflictException(REMOVED_ACCOUNT_MESSAGE);
      if (!student.passwordHash) {
        throw new ConflictException('This student has no password, so the account cannot be reactivated.');
      }

      await tx.user.update({ where: { id }, data: { status: AccountStatus.ACTIVE } });

      await this.audit.record(
        { actorId: admin.id, action: 'student.reactivated', entityType: 'user', entityId: id, ipAddress: context.ipAddress },
        tx,
      );
      return this.detailOf(tx, id);
    });
  }

  // ---------------------------------------------------------------- withdraw

  /** Ends her current enrollment (her history is kept) and so locks her course. */
  async withdraw(admin: AuthenticatedUser, id: string, context: RequestContext): Promise<StudentDetailResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.findStudent(tx, id);

      const current = await this.activeEnrollment(tx, id);
      if (!current) throw new ConflictException(NOT_ENROLLED_MESSAGE);

      await lockCohort(tx, current.cohortId); // take turns with anyone being accepted or archiving it

      const ended = await tx.enrollment.updateMany({
        where: { id: current.id, status: EnrollmentStatus.ACTIVE },
        data: { status: EnrollmentStatus.WITHDRAWN, endedAt: new Date() },
      });
      if (ended.count !== 1) throw new ConflictException(NOT_ENROLLED_MESSAGE);

      await this.audit.record(
        {
          actorId: admin.id,
          action: 'student.withdrawn',
          entityType: 'user',
          entityId: id,
          metadata: { cohortId: current.cohortId, enrollmentId: current.id },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return this.detailOf(tx, id);
    });
  }

  // -------------------------------------------------------------------- move

  /**
   * Moves her from her current cohort to another one: the old enrollment
   * ends as TRANSFERRED and a new ACTIVE one starts, in a single step. The new
   * cohort must have a free seat and be open, exactly as when accepting.
   */
  async move(
    admin: AuthenticatedUser,
    id: string,
    dto: MoveStudentDto,
    context: RequestContext,
  ): Promise<StudentDetailResult> {
    return this.prisma.$transaction(async (tx) => {
      const student = await this.findStudent(tx, id);

      const current = await this.activeEnrollment(tx, id);
      if (!current) throw new ConflictException(NOT_ENROLLED_MESSAGE);
      if (current.cohortId === dto.cohortId) throw new ConflictException('She is already in this cohort.');

      // Lock BOTH cohorts, always in the same (sorted) order.
      for (const cohortId of [current.cohortId, dto.cohortId].sort()) {
        await lockCohort(tx, cohortId);
      }

      if (student.status === AccountStatus.SUSPENDED) {
        throw new ConflictException("This student's account is suspended, so she cannot be moved.");
      }

      const target = await tx.cohort.findUnique({
        where: { id: dto.cohortId },
        select: { id: true, status: true, capacity: true, course: { select: { status: true } } },
      });
      if (!target) throw new NotFoundException('Cohort not found.');
      if (target.status === CohortStatus.CLOSED) {
        throw new ConflictException('Students cannot be moved into a closed cohort.');
      }
      if (target.course.status === CourseStatus.ARCHIVED) {
        throw new ConflictException('Students cannot be moved into a cohort of an archived course.');
      }
      if (target.capacity !== null) {
        const taken = await tx.enrollment.count({ where: { cohortId: target.id, status: EnrollmentStatus.ACTIVE } });
        if (taken >= target.capacity) throw new ConflictException('This cohort is full.');
      }

      // End the old enrollment FIRST (a student may have only one active one).
      const ended = await tx.enrollment.updateMany({
        where: { id: current.id, status: EnrollmentStatus.ACTIVE },
        data: { status: EnrollmentStatus.TRANSFERRED, endedAt: new Date() },
      });
      if (ended.count !== 1) throw new ConflictException(NOT_ENROLLED_MESSAGE);

      await tx.enrollment.create({ data: { studentId: id, cohortId: target.id, createdById: admin.id } });

      await this.audit.record(
        {
          actorId: admin.id,
          action: 'student.moved',
          entityType: 'user',
          entityId: id,
          metadata: { fromCohortId: current.cohortId, toCohortId: target.id },
          ipAddress: context.ipAddress,
        },
        tx,
      );
      return this.detailOf(tx, id);
    });
  }

  // ----------------------------------------------------------------- helpers

  /** Loads a student, or throws "not found" (also for ids of admins and instructors). */
  private async findStudent(db: DbClient, id: string) {
    const row = await db.user.findFirst({
      where: { id, role: Role.STUDENT },
      select: { id: true, email: true, fullName: true, status: true, passwordHash: true },
    });
    if (!row) throw new NotFoundException('Student not found.');
    return row;
  }

  private activeEnrollment(db: DbClient, studentId: string) {
    return db.enrollment.findFirst({
      where: { studentId, status: EnrollmentStatus.ACTIVE },
      select: { id: true, cohortId: true },
    });
  }

  private async detailOf(db: DbClient, id: string): Promise<StudentDetailResult> {
    const row = await db.user.findFirstOrThrow({ where: { id, role: Role.STUDENT }, select: studentDetailSelect });
    return { student: toStudentDetail(row, todayInProgrammeZone()) };
  }
}