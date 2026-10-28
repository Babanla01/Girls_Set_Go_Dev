/**
 * student-helpers.ts
 * ---------------------------------------------------------------------------
 * Small helpers for tests that need students, applications and enrollments.
 * They create rows straight in the TEST database, which is fast and does not
 * depend on the signup route (that route has its own tests).
 */
import { AccountStatus, EnrollmentStatus, Role } from '@prisma/client';

import type { TestKit } from './test-kit';

export const APPLICANT_DOB = '2000-05-05';

export interface ApplicantOptions {
  fullName: string;
  email: string;
  /** When the application was submitted (handy for sorting and date filters). */
  submittedAt: Date;
  /** When the account was created (handy for sorting). */
  createdAt: Date;
  withGuardian: boolean;
  preferredTrackId: string;
}

/** A student with a profile and a PENDING application. */
export async function makeApplicant(kit: TestKit, trackId: string, over: Partial<ApplicantOptions> = {}) {
  const email = over.email ?? 'ada@example.org';

  const user = await kit.prisma.user.create({
    data: {
      email,
      fullName: over.fullName ?? 'Ada Okoye',
      role: Role.STUDENT,
      status: AccountStatus.ACTIVE,
      passwordHash: kit.goodHash,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      studentProfile: {
        create: {
          dateOfBirth: new Date(APPLICANT_DOB),
          phone: '08012345678',
          location: 'Lagos',
          schoolName: 'Government College',
          gradeLevel: 'SS2',
          ...(over.withGuardian
            ? { guardianName: 'Mrs Okoye', guardianEmail: 'mum@example.org', guardianPhone: '08098765432' }
            : {}),
        },
      },
      studentApplication: {
        create: {
          preferredTrackId: over.preferredTrackId ?? trackId,
          whyJoin: 'I love building things with code.',
          hopeToLearn: 'How robots and AI really work.',
          stemExperience: 'Built a small robot.',
          consentAcceptedAt: new Date(),
          consentVersion: 'v1',
          ...(over.submittedAt ? { submittedAt: over.submittedAt } : {}),
        },
      },
    },
    include: { studentApplication: true },
  });

  return { studentId: user.id, applicationId: user.studentApplication!.id, email };
}

/** Puts a student in a cohort directly (ACTIVE unless told otherwise). */
export async function enroll(
  kit: TestKit,
  studentId: string,
  cohortId: string,
  over: Partial<{ status: EnrollmentStatus; enrolledAt: Date; endedAt: Date; applicationId: string }> = {},
) {
  const status = over.status ?? EnrollmentStatus.ACTIVE;

  return kit.prisma.enrollment.create({
    data: {
      studentId,
      cohortId,
      status,
      endedAt: status === EnrollmentStatus.ACTIVE ? null : (over.endedAt ?? new Date()),
      ...(over.enrolledAt ? { enrolledAt: over.enrolledAt } : {}),
      ...(over.applicationId ? { applicationId: over.applicationId } : {}),
    },
  });
}