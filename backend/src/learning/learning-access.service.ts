/**
 * learning-access.service.ts
 * ---------------------------------------------------------------------------
 * Decides what course (if any) a student may open RIGHT NOW. It runs on every
 * request and reads the database each time, so access ends the moment an admin
 * withdraws her or moves her.
 *
 *   NO_ENROLLMENT   no place in a cohort (pending, declined, withdrawn, never applied)
 *   NOT_STARTED     she is accepted, but her cohort has not started yet
 *   NOT_READY       her cohort's course has nothing published yet
 *   READY           she may learn (ACTIVE enrollment) or read (COMPLETED enrollment, read-only)
 *
 * Course access comes ONLY from an enrollment, never from an application or a flag.
 */
import { Injectable } from '@nestjs/common';
import { CohortStatus, EnrollmentStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

export interface CohortInfo {
  id: string;
  name: string;
  startsOn: Date;
  endsOn: Date;
}

export interface LearningContext {
  enrollmentId: string;
  /** true for a student who completed the course: everything is readable, nothing can change. */
  readOnly: boolean;
  cohort: CohortInfo;
  /** The course copy of her cohort and its LIVE version. */
  contentId: string;
  version: number;
}

export type LearningAccess =
  | { kind: 'NO_ENROLLMENT' }
  | { kind: 'NOT_STARTED'; cohort: CohortInfo }
  | { kind: 'NOT_READY'; cohort: CohortInfo }
  | { kind: 'READY'; context: LearningContext };

const enrollmentSelect = {
  id: true,
  status: true,
  cohort: {
    select: {
      id: true,
      name: true,
      status: true,
      startsOn: true,
      endsOn: true,
      courseContent: { select: { id: true, publishedVersion: true } },
    },
  },
} as const;

@Injectable()
export class LearningAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: AuthenticatedUser): Promise<LearningAccess> {
    // At most one enrollment is ACTIVE; otherwise use the most recently finished one.
    const enrollment =
      (await this.prisma.enrollment.findFirst({
        where: { studentId: user.id, status: EnrollmentStatus.ACTIVE },
        select: enrollmentSelect,
      })) ??
      (await this.prisma.enrollment.findFirst({
        where: { studentId: user.id, status: EnrollmentStatus.COMPLETED },
        orderBy: [{ endedAt: 'desc' }, { id: 'asc' }],
        select: enrollmentSelect,
      }));
    if (!enrollment) return { kind: 'NO_ENROLLMENT' };

    const { cohort } = enrollment;
    const info: CohortInfo = { id: cohort.id, name: cohort.name, startsOn: cohort.startsOn, endsOn: cohort.endsOn };

    if (enrollment.status === EnrollmentStatus.ACTIVE && cohort.status === CohortStatus.PLANNED) {
      return { kind: 'NOT_STARTED', cohort: info };
    }

    const content = cohort.courseContent;
    if (!content || content.publishedVersion === null) return { kind: 'NOT_READY', cohort: info };

    return {
      kind: 'READY',
      context: {
        enrollmentId: enrollment.id,
        readOnly: enrollment.status === EnrollmentStatus.COMPLETED,
        cohort: info,
        contentId: content.id,
        version: content.publishedVersion,
      },
    };
  }
}
