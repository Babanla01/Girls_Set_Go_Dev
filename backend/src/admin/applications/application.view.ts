/**
 * application.view.ts
 * ---------------------------------------------------------------------------
 * What an application looks like to an ADMIN.
 *   - the LIST view is small (no date of birth, phone or guardian details)
 *   - the DETAIL view shows everything the student submitted
 * Queries ask the database for only these fields and the mappers copy them one
 * by one, so nothing is exposed by accident.
 */
import type { AccountStatus, ApplicationStatus, Prisma } from '@prisma/client';

import { formatCalendarDate } from '../../catalog/catalog.util';
import { cohortSelect, CohortView, toCohortView } from '../../catalog/cohort.view';
import { ageOnDate } from '../../students/age';

export const applicationListSelect = {
  id: true,
  reference: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  student: { select: { id: true, fullName: true, email: true, emailVerifiedAt: true, status: true } },
  preferredTrack: { select: { id: true, name: true } },
} satisfies Prisma.StudentApplicationSelect;

export const applicationDetailSelect = {
  id: true,
  reference: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  whyJoin: true,
  hopeToLearn: true,
  stemExperience: true,
  decisionNote: true,
  declineReason: true,
  personalNote: true,
  termsAcceptedAt: true,
  privacyAcceptedAt: true,
  guardianConsentAt: true,
  consentVersion: true,
  preferredTrack: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, fullName: true } },
  student: {
    select: {
      id: true,
      fullName: true,
      email: true,
      emailVerifiedAt: true,
      status: true,
      studentProfile: {
        select: {
          dateOfBirth: true,
          phone: true,
          city: true,
          state: true,
          schoolName: true,
          gradeLevel: true,
          guardianName: true,
          guardianEmail: true,
          guardianPhone: true,
        },
      },
    },
  },
  enrollment: { select: { id: true, reference: true, enrolledAt: true, status: true, cohort: { select: cohortSelect } } },
} satisfies Prisma.StudentApplicationSelect;

type ListRow = Prisma.StudentApplicationGetPayload<{ select: typeof applicationListSelect }>;
type DetailRow = Prisma.StudentApplicationGetPayload<{ select: typeof applicationDetailSelect }>;

export interface ApplicationSummary {
  id: string;
  /** e.g. "GSG-2026-0391" */
  reference: string;
  status: ApplicationStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  student: { id: string; fullName: string; email: string; emailVerified: boolean; accountStatus: AccountStatus };
  preferredTrack: { id: string; name: string } | null;
}

export function toApplicationSummary(row: ListRow): ApplicationSummary {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    student: {
      id: row.student.id,
      fullName: row.student.fullName,
      email: row.student.email,
      emailVerified: row.student.emailVerifiedAt !== null,
      accountStatus: row.student.status,
    },
    preferredTrack: row.preferredTrack ? { id: row.preferredTrack.id, name: row.preferredTrack.name } : null,
  };
}

/** `today` is "YYYY-MM-DD" in the programme's timezone (used for the age and the cohort phase). */
export function toApplicationDetail(row: DetailRow, today: string) {
  const profile = row.student.studentProfile;

  return {
    ...toApplicationSummary(row),
    // The profile can be missing once a declined applicant's data has been removed (retention).
    profile: profile
      ? {
          dateOfBirth: formatCalendarDate(profile.dateOfBirth),
          age: ageOnDate(formatCalendarDate(profile.dateOfBirth), today),
          phone: profile.phone,
          city: profile.city,
          state: profile.state,
          schoolName: profile.schoolName,
          gradeLevel: profile.gradeLevel,
          guardian: profile.guardianName
            ? { name: profile.guardianName, email: profile.guardianEmail, phone: profile.guardianPhone }
            : null,
        }
      : null,
    answers: { whyJoin: row.whyJoin, hopeToLearn: row.hopeToLearn, stemExperience: row.stemExperience },
    consent: {
      termsAcceptedAt: row.termsAcceptedAt,
      privacyAcceptedAt: row.privacyAcceptedAt,
      guardianConsentAt: row.guardianConsentAt,
      version: row.consentVersion,
    },
    review: row.reviewedAt
      ? {
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt,
          note: row.decisionNote, // private note (admins only)
          declineReason: row.declineReason, // internal, for reporting
          personalNote: row.personalNote, // what was written into the decline email
        }
      : null,
    enrollment: row.enrollment
      ? {
          id: row.enrollment.id,
          reference: row.enrollment.reference,
          status: row.enrollment.status,
          enrolledAt: row.enrollment.enrolledAt,
          cohort: toCohortView(row.enrollment.cohort, today) as CohortView,
        }
      : null,
  };
}