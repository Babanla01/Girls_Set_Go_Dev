/**
 * grading-scope.service.ts
 * ---------------------------------------------------------------------------
 * WHOSE submissions a person may see and review:
 *   - an admin: every cohort;
 *   - an instructor: only the cohorts assigned to her.
 * Checked against the database on every request (the same ownership rule as editing that
 * cohort's course), so removing an assignment takes effect on the next click.
 */
import { Injectable } from '@nestjs/common';
import { ContentKind, Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PolicyService } from '../auth/policy/policy.service';
import type { ManageResource } from '../course-content/content-editor.service';
import { COURSE_CONTENT_MANAGE } from '../course-content/course-content.constants';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GradingScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
  ) {}

  /** The cohorts this person may grade, or null for "all of them" (an admin). */
  async cohortIds(user: AuthenticatedUser): Promise<string[] | null> {
    if (user.role === Role.ADMIN) return null;
    const rows = await this.prisma.cohortInstructor.findMany({ where: { instructorId: user.id }, select: { cohortId: true } });
    return rows.map((row) => row.cohortId);
  }

  /** 403 unless this person may grade that cohort. */
  async assertCanGrade(user: AuthenticatedUser, cohortId: string): Promise<void> {
    await this.policy.assertCan<ManageResource>(user, COURSE_CONTENT_MANAGE, { kind: ContentKind.COHORT_COPY, cohortId });
  }
}
