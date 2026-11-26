/**
 * profile.service.ts
 * ---------------------------------------------------------------------------
 * A student's own profile.
 *
 *  - She can edit: phone, school, grade, interests (chips), her goal for the bootcamp and her
 *    "after the bootcamp" choice. Her name, email, date of birth, location and guardian details
 *    change only through support (the DTO refuses them with a friendly sentence).
 *  - Only HER OWN profile is reachable here. Interests and goals are never public; instructors
 *    and admins read them through their own screens.
 *  - Every change is written to the audit log with the NAMES of the fields that changed - never
 *    their values, because phone and school are personal details.
 *  - Nothing is written (and nothing audited) when a save changes nothing.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';

import type { AuthenticatedUser, RequestContext } from '../auth/auth.types';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import { changedFields, cleanInterests, initialsOf, interestsProblem, ProfileFields } from './profile-rules';
import {
  AFTER_BOOTCAMP_CHOICES,
  afterBootcampLabel,
  MAX_GOAL_LENGTH,
  MAX_INTEREST_LENGTH,
  MAX_INTERESTS,
  SUPPORT_ONLY_MESSAGE,
  VISIBILITY_NOTE,
} from './profile.constants';

const profileSelect = {
  phone: true,
  city: true,
  state: true,
  schoolName: true,
  gradeLevel: true,
  interests: true,
  goal: true,
  afterBootcamp: true,
} as const;

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(user: AuthenticatedUser) {
    const [account, profile, enrollment] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { fullName: true, email: true } }),
      this.prisma.studentProfile.findUnique({ where: { userId: user.id }, select: profileSelect }),
      this.currentEnrollment(user.id),
    ]);
    if (!profile) throw new NotFoundException('Profile not found.');

    return {
      student: { fullName: account.fullName, email: account.email, initials: initialsOf(account.fullName) },
      profile: {
        phone: profile.phone,
        schoolName: profile.schoolName,
        gradeLevel: profile.gradeLevel,
        location: { city: profile.city, state: profile.state },
        interests: profile.interests,
        goal: profile.goal,
        afterBootcamp: profile.afterBootcamp,
        afterBootcampLabel: afterBootcampLabel(profile.afterBootcamp),
      },
      afterBootcampChoices: AFTER_BOOTCAMP_CHOICES,
      limits: { maxInterests: MAX_INTERESTS, maxInterestLength: MAX_INTEREST_LENGTH, maxGoalLength: MAX_GOAL_LENGTH },
      enrollment: enrollment
        ? {
            track: enrollment.cohort.course.track.name,
            course: enrollment.cohort.course.title,
            cohort: enrollment.cohort.name,
            instructors: enrollment.cohort.instructors.map((row) => row.instructor.fullName),
          }
        : null,
      visibility: VISIBILITY_NOTE,
      supportNote: SUPPORT_ONLY_MESSAGE,
    };
  }

  async update(user: AuthenticatedUser, dto: UpdateProfileDto, context: RequestContext) {
    const touched =
      dto.phone !== undefined ||
      dto.schoolName !== undefined ||
      dto.gradeLevel !== undefined ||
      dto.interests !== undefined ||
      dto.goal !== undefined ||
      dto.afterBootcamp !== undefined;
    if (!touched) throw new BadRequestException('Nothing to update.');

    let interests: string[] | undefined;
    if (dto.interests !== undefined) {
      interests = cleanInterests(dto.interests);
      const problem = interestsProblem(interests);
      if (problem) throw new BadRequestException(problem);
    }

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.studentProfile.findUnique({ where: { userId: user.id }, select: profileSelect });
      if (!before) throw new NotFoundException('Profile not found.');

      const current: ProfileFields = {
        phone: before.phone,
        schoolName: before.schoolName,
        gradeLevel: before.gradeLevel,
        interests: before.interests,
        goal: before.goal,
        afterBootcamp: before.afterBootcamp,
      };
      const next: ProfileFields = {
        phone: dto.phone ?? current.phone,
        schoolName: dto.schoolName ?? current.schoolName,
        gradeLevel: dto.gradeLevel ?? current.gradeLevel,
        interests: interests ?? current.interests,
        goal: dto.goal !== undefined ? dto.goal : current.goal,
        afterBootcamp: dto.afterBootcamp !== undefined ? dto.afterBootcamp : current.afterBootcamp,
      };

      const changed = changedFields(current, next);
      if (changed.length === 0) return; // nothing really changed

      // Only the fields that changed are written.
      await tx.studentProfile.update({
        where: { userId: user.id },
        data: Object.fromEntries(changed.map((field) => [field, next[field]])),
      });

      // The audit entry names the fields only - phone and school are personal details.
      await this.audit.record(
        {
          actorId: user.id,
          action: 'student.profile_updated',
          entityType: 'student_profile',
          entityId: user.id,
          metadata: { fields: changed },
          ipAddress: context.ipAddress,
        },
        tx,
      );
    });

    return this.get(user);
  }

  /** The enrollment she is learning in now, else the most recent one she completed. */
  private async currentEnrollment(studentId: string) {
    const select = {
      cohort: {
        select: {
          name: true,
          course: { select: { title: true, track: { select: { name: true } } } },
          instructors: { select: { instructor: { select: { fullName: true } } } },
        },
      },
    } as const;

    return (
      (await this.prisma.enrollment.findFirst({ where: { studentId, status: EnrollmentStatus.ACTIVE }, select })) ??
      (await this.prisma.enrollment.findFirst({
        where: { studentId, status: EnrollmentStatus.COMPLETED },
        orderBy: [{ endedAt: 'desc' }, { id: 'asc' }],
        select,
      }))
    );
  }
}
