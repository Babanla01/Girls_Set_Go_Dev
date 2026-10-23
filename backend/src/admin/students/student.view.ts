/**
 * student.view.ts
 * ---------------------------------------------------------------------------
 * What a student looks like to an ADMIN.
 *   - the LIST view is small: no date of birth, phone or guardian details
 *   - the DETAIL view adds the profile, the application and the enrollment
 *     history (admin-only; this is where the sensitive details live)
 * Queries ask for only these fields; the mappers copy them one by one.
 */
import type { AccountStatus, ApplicationStatus, EnrollmentStatus, Prisma } from '@prisma/client';

import { formatCalendarDate } from '../../catalog/catalog.util';
import { ageOnDate } from '../../students/age';

export const studentListSelect = {
  id: true,
  fullName: true,
  email: true,
  emailVerifiedAt: true,
  status: true,
  createdAt: true,
  studentApplication: { select: { id: true, status: true, submittedAt: true } },
  // Her CURRENT enrollment (at most one is ever active).
  enrollments: {
    where: { status: 'ACTIVE' },
    take: 1,
    select: {
      cohort: { select: { id: true, name: true, course: { select: { id: true, title: true, track: { select: { id: true, name: true } } } } } },
    },
  },
} satisfies Prisma.UserSelect;

export const studentDetailSelect = {
  id: true,
  fullName: true,
  email: true,
  emailVerifiedAt: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  studentProfile: {
    select: {
      dateOfBirth: true,
      phone: true,
      location: true,
      schoolName: true,
      gradeLevel: true,
      guardianName: true,
      guardianEmail: true,
      guardianPhone: true,
    },
  },
  studentApplication: {
    select: {
      id: true,
      status: true,
      submittedAt: true,
      reviewedAt: true,
      whyJoin: true,
      hopeToLearn: true,
      stemExperience: true,
      decisionNote: true,
      consentAcceptedAt: true,
      guardianConsentAt: true,
      consentVersion: true,
      preferredTrack: { select: { id: true, name: true } },
      reviewedBy: { select: { id: true, fullName: true } },
    },
  },
  // The full history, newest first.
  enrollments: {
    orderBy: [{ enrolledAt: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      status: true,
      enrolledAt: true,
      endedAt: true,
      cohort: { select: { id: true, name: true, course: { select: { id: true, title: true, track: { select: { id: true, name: true } } } } } },
    },
  },
} satisfies Prisma.UserSelect;

type ListRow = Prisma.UserGetPayload<{ select: typeof studentListSelect }>;
type DetailRow = Prisma.UserGetPayload<{ select: typeof studentDetailSelect }>;

export interface StudentSummary {
  id: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
  accountStatus: AccountStatus;
  createdAt: Date;
  application: { id: string; status: ApplicationStatus; submittedAt: Date } | null;
  enrollment: { cohortId: string; cohortName: string; courseTitle: string; trackName: string } | null;
}

export function toStudentSummary(row: ListRow): StudentSummary {
  const current = row.enrollments[0];
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
    accountStatus: row.status,
    createdAt: row.createdAt,
    application: row.studentApplication
      ? { id: row.studentApplication.id, status: row.studentApplication.status, submittedAt: row.studentApplication.submittedAt }
      : null,
    enrollment: current
      ? {
          cohortId: current.cohort.id,
          cohortName: current.cohort.name,
          courseTitle: current.cohort.course.title,
          trackName: current.cohort.course.track.name,
        }
      : null,
  };
}

export interface EnrollmentHistoryItem {
  id: string;
  status: EnrollmentStatus;
  enrolledAt: Date;
  endedAt: Date | null;
  cohort: { id: string; name: string };
  course: { id: string; title: string };
  track: { id: string; name: string };
}

export function toStudentDetail(row: DetailRow, today: string) {
  const profile = row.studentProfile;
  const application = row.studentApplication;

  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
    accountStatus: row.status,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    profile: profile
      ? {
          dateOfBirth: formatCalendarDate(profile.dateOfBirth),
          age: ageOnDate(formatCalendarDate(profile.dateOfBirth), today),
          phone: profile.phone,
          location: profile.location,
          schoolName: profile.schoolName,
          gradeLevel: profile.gradeLevel,
          guardian: profile.guardianName
            ? { name: profile.guardianName, email: profile.guardianEmail, phone: profile.guardianPhone }
            : null,
        }
      : null,
    application: application
      ? {
          id: application.id,
          status: application.status,
          submittedAt: application.submittedAt,
          reviewedAt: application.reviewedAt,
          preferredTrack: application.preferredTrack,
          answers: { whyJoin: application.whyJoin, hopeToLearn: application.hopeToLearn, stemExperience: application.stemExperience },
          consent: { acceptedAt: application.consentAcceptedAt, guardianConsentAt: application.guardianConsentAt, version: application.consentVersion },
          review: application.reviewedAt
            ? { reviewedBy: application.reviewedBy, note: application.decisionNote }
            : null,
        }
      : null,
    enrollments: row.enrollments.map(
      (e): EnrollmentHistoryItem => ({
        id: e.id,
        status: e.status,
        enrolledAt: e.enrolledAt,
        endedAt: e.endedAt,
        cohort: { id: e.cohort.id, name: e.cohort.name },
        course: { id: e.cohort.course.id, title: e.cohort.course.title },
        track: { id: e.cohort.course.track.id, name: e.cohort.course.track.name },
      }),
    ),
  };
}