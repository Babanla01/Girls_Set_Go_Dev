#!/usr/bin/env bash
# Batch 5B - the student profile, the remembered panel state and the learning dashboard.
# Run from the repo root.
set -euo pipefail
cd backend
mkdir -p prisma/migrations/20261121000000_student_profile_and_preferences src/profile/dto

# ============================================================================
cat > prisma/migrations/20261121000000_student_profile_and_preferences/migration.sql <<'EOF'
-- Batch 5B: what a student can say about herself, and a small per-user setting.
--
--   student_profiles   three new columns: her interests (a short list of chips), her goal for the
--                      bootcamp (up to 280 characters) and her "after the bootcamp" choice. These
--                      are visible only to her, her instructors and the admins - never public.
--   user_preferences   one row per person who has changed a setting: for now, whether the profile
--                      panel is open, collapsed to a thin rail, or closed. Remembered per user.
-- Written by hand (CHECK rules); names follow Prisma's conventions.

ALTER TABLE "student_profiles"
  ADD COLUMN "interests"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "goal"           VARCHAR(280),
  ADD COLUMN "after_bootcamp" VARCHAR(60);

-- At most 10 interests; a goal or choice is either empty (NULL) or real text - never blank.
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_interests_check"      CHECK (cardinality("interests") <= 10),
  ADD CONSTRAINT "student_profiles_goal_check"           CHECK ("goal" IS NULL OR btrim("goal") <> ''),
  ADD CONSTRAINT "student_profiles_after_bootcamp_check" CHECK ("after_bootcamp" IS NULL OR btrim("after_bootcamp") <> '');

-- ---------------------------------------------------------------------------
CREATE TYPE "PanelState" AS ENUM ('OPEN', 'COLLAPSED', 'CLOSED');

CREATE TABLE "user_preferences" (
  "user_id"       UUID           NOT NULL,
  "profile_panel" "PanelState"   NOT NULL DEFAULT 'OPEN',
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_preferences"
  ADD CONSTRAINT "user_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EOF

# ============================================================================
cat > src/profile/profile.constants.ts <<'EOF'
/**
 * profile.constants.ts
 * ---------------------------------------------------------------------------
 * The limits and the choices of the student profile, in ONE place.
 */

/**
 * The "After the bootcamp I'd like to..." choices. The database stores the KEY, so changing a
 * label - or adding a choice - never needs a migration.
 */
export const AFTER_BOOTCAMP_CHOICES = [
  { key: 'STUDY_FURTHER', label: 'Study further' },
  { key: 'START_WORKING', label: 'Start working' },
  { key: 'BUILD_OWN_PROJECTS', label: 'Build my own projects' },
  { key: 'JOIN_TALENT_ACADEMY', label: 'Join the Talent Academy' },
  { key: 'NOT_SURE_YET', label: 'Not sure yet' },
] as const;

export type AfterBootcampKey = (typeof AFTER_BOOTCAMP_CHOICES)[number]['key'];

export const AFTER_BOOTCAMP_KEYS: readonly AfterBootcampKey[] = AFTER_BOOTCAMP_CHOICES.map((choice) => choice.key);

export const afterBootcampLabel = (key: string | null): string | null =>
  AFTER_BOOTCAMP_CHOICES.find((choice) => choice.key === key)?.label ?? null;

/** Interests are short "chips": at most 10, each at most 30 characters. */
export const MAX_INTERESTS = 10;
export const MAX_INTEREST_LENGTH = 30;

/** The goal for the bootcamp: 280 characters at most. */
export const MAX_GOAL_LENGTH = 280;

/** Shown when someone tries to change what only support may change (PRF-02). */
export const SUPPORT_ONLY_MESSAGE =
  'To change your name, email, date of birth, location or guardian details, please contact support.';

/** Who can see the interests and the goal (PRF-03). */
export const VISIBILITY_NOTE =
  'Only you, your instructor and the Girls Set Go team can see your interests and goals. They are never shown on the public website.';
EOF

# ============================================================================
cat > src/profile/profile-rules.ts <<'EOF'
/**
 * profile-rules.ts
 * ---------------------------------------------------------------------------
 * Small pure rules for the student profile (no database).
 */
import { MAX_INTEREST_LENGTH, MAX_INTERESTS } from './profile.constants';

/**
 * Tidies the interest chips: trims each one, squeezes inner spaces, drops empty ones and
 * removes repeats (ignoring capital letters - the first spelling wins). The order is kept.
 */
export function cleanInterests(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const text = item.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

/** A plain-English problem with a cleaned list of interests, or null when it is fine. */
export function interestsProblem(items: readonly string[]): string | null {
  if (items.length > MAX_INTERESTS) return `You can add up to ${MAX_INTERESTS} interests.`;
  const tooLong = items.find((item) => item.length > MAX_INTEREST_LENGTH);
  if (tooLong) return `Each interest can be up to ${MAX_INTEREST_LENGTH} characters. "${tooLong.slice(0, 20)}..." is too long.`;
  return null;
}

/** The editable parts of a profile. */
export interface ProfileFields {
  phone: string;
  schoolName: string;
  gradeLevel: string;
  interests: string[];
  goal: string | null;
  afterBootcamp: string | null;
}

/** Which fields differ - used for the audit entry, which records the NAMES of the fields and never their values. */
export function changedFields(before: ProfileFields, after: ProfileFields): (keyof ProfileFields)[] {
  const changed: (keyof ProfileFields)[] = [];
  if (before.phone !== after.phone) changed.push('phone');
  if (before.schoolName !== after.schoolName) changed.push('schoolName');
  if (before.gradeLevel !== after.gradeLevel) changed.push('gradeLevel');
  if (before.interests.length !== after.interests.length || before.interests.some((item, index) => item !== after.interests[index])) {
    changed.push('interests');
  }
  if (before.goal !== after.goal) changed.push('goal');
  if (before.afterBootcamp !== after.afterBootcamp) changed.push('afterBootcamp');
  return changed;
}

/** "Amara Okafor" -> "AO"; a single name -> its first letter. Shown instead of a photo. */
export function initialsOf(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toUpperCase();
}
EOF

# ============================================================================
cat > src/profile/dto/update-profile.dto.ts <<'EOF'
/**
 * update-profile.dto.ts - what a student may change about herself.
 *
 *   Editable: phone, school, grade, interests (chips), goal (280 characters), after-bootcamp choice.
 *   Send only what changes. A goal or a choice sent as blank (or null) is cleared.
 *
 *   NOT editable here (PRF-02): name, email, date of birth, location, guardian details. Sending
 *   any of them is refused with a friendly sentence that points to support.
 */
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmpty, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

import { PHONE_MESSAGE, PHONE_PATTERN } from '../../students/dto/register-student.dto';
import { AFTER_BOOTCAMP_KEYS, AfterBootcampKey, MAX_GOAL_LENGTH, SUPPORT_ONLY_MESSAGE } from '../profile.constants';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Blank text becomes null, which means "clear it". */
const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? (value.replace(/\r\n?/g, '\n').trim() === '' ? null : value.replace(/\r\n?/g, '\n').trim()) : value;

export class UpdateProfileDto {
  @IsOptional()
  @Transform(trimmed)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 200)
  schoolName?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 50)
  gradeLevel?: string;

  /** A rough guard here; the exact rules (10 chips, 30 characters each, no repeats) are applied after tidying. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  interests?: string[];

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(MAX_GOAL_LENGTH)
  goal?: string | null;

  @IsOptional()
  @Transform(blankToNull)
  @IsIn(AFTER_BOOTCAMP_KEYS as unknown as string[])
  afterBootcamp?: AfterBootcampKey | null;

  // --- changed through support only: any value here is refused ---------------------------
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) fullName?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) email?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) dateOfBirth?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) city?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) state?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) guardianName?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) guardianEmail?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) guardianPhone?: unknown;
}
EOF

cat > src/profile/dto/preferences.dto.ts <<'EOF'
/**
 * preferences.dto.ts - the settings a person can save for herself. For now: the profile panel.
 */
import { IsEnum } from 'class-validator';
import { PanelState } from '@prisma/client';

export class UpdatePreferencesDto {
  /** OPEN, COLLAPSED (a thin rail with icons) or CLOSED. */
  @IsEnum(PanelState)
  profilePanel!: PanelState;
}
EOF

# ============================================================================
cat > src/profile/profile.service.ts <<'EOF'
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
EOF

# ============================================================================
cat > src/profile/preferences.service.ts <<'EOF'
/**
 * preferences.service.ts
 * ---------------------------------------------------------------------------
 * Small settings a person keeps for herself, remembered per user. For now: whether the profile
 * panel is OPEN, COLLAPSED (a thin rail with icons) or CLOSED. Everyone starts with OPEN; a
 * row exists only after someone has changed a setting. Works for every role.
 */
import { Injectable } from '@nestjs/common';
import { PanelState } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdatePreferencesDto } from './dto/preferences.dto';

@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: AuthenticatedUser) {
    const row = await this.prisma.userPreference.findUnique({ where: { userId: user.id }, select: { profilePanel: true } });
    return { profilePanel: row?.profilePanel ?? PanelState.OPEN };
  }

  async set(user: AuthenticatedUser, dto: UpdatePreferencesDto) {
    const row = await this.prisma.userPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, profilePanel: dto.profilePanel },
      update: { profilePanel: dto.profilePanel },
      select: { profilePanel: true },
    });
    return { profilePanel: row.profilePanel };
  }
}
EOF

cat > src/profile/profile.controller.ts <<'EOF'
/**
 * profile.controller.ts  (students only)
 * ---------------------------------------------------------------------------
 *   GET   /api/v1/students/me/profile   her profile: editable details, the choices, her track and cohort
 *   PATCH /api/v1/students/me/profile   change phone, school, grade, interests, goal or after-bootcamp choice
 *
 * Name, email, date of birth, location and guardian details are changed through support.
 */
import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';

@Roles(Role.STUDENT)
@Controller('students/me')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('profile')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.profile.get(user);
  }

  @Patch('profile')
  update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto, @Req() req: Request) {
    return this.profile.update(user, dto, getRequestContext(req));
  }
}
EOF

cat > src/profile/preferences.controller.ts <<'EOF'
/**
 * preferences.controller.ts  (every signed-in role)
 * ---------------------------------------------------------------------------
 *   GET /api/v1/me/preferences   her saved settings (the profile panel: OPEN, COLLAPSED or CLOSED)
 *   PUT /api/v1/me/preferences   save them
 */
import { Body, Controller, Get, Put } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UpdatePreferencesDto } from './dto/preferences.dto';
import { PreferencesService } from './preferences.service';

@Controller('me/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.get(user);
  }

  @Put()
  set(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdatePreferencesDto) {
    return this.preferences.set(user, dto);
  }
}
EOF

cat > src/profile/profile.module.ts <<'EOF'
/**
 * profile.module.ts
 * ---------------------------------------------------------------------------
 * A student's own profile (interests, goals, school...) and the settings remembered per user
 * (the profile panel's state). Uses the global Prisma and audit services.
 */
import { Module } from '@nestjs/common';

import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  controllers: [ProfileController, PreferencesController],
  providers: [ProfileService, PreferencesService],
})
export class ProfileModule {}
EOF

# ============================================================================
cat > src/learning/dashboard-rules.ts <<'EOF'
/**
 * dashboard-rules.ts
 * ---------------------------------------------------------------------------
 * The small decisions behind the student's learning dashboard, as pure functions (no database):
 *   - how many weeks are really COMPLETED (lessons done AND the assignment reviewed);
 *   - which week is "this week";
 *   - which assignment to show as "your next assignment";
 *   - the live classes: the one held last, the next one, and when its JOIN LINK may be shown;
 *   - the "journey" summary for a student who finished the course.
 */
import type { Snapshot } from '../course-content/snapshot';
import type { WeekProgress } from './learning-rules';

/** The join link appears this many minutes before a class starts. */
export const JOIN_OPENS_MINUTES_BEFORE = 10;

const MINUTE_MS = 60_000;

/**
 * Weeks completed = every lesson done AND the week's assignment reviewed (a week with no
 * assignment needs only its lessons). An empty week (no lessons, no assignment) never counts.
 */
export function weeksCompleted(snapshot: Snapshot, weeks: readonly WeekProgress[], graded: ReadonlySet<string>): number {
  return weeks.filter(
    (week, index) =>
      week.status === 'COMPLETE' && graded.has(week.id) && (week.lessonsTotal > 0 || snapshot.weeks[index].assignment !== null),
  ).length;
}

export interface ThisWeek {
  id: string;
  position: number;
  title: string;
  lessonsDone: number;
  lessonsTotal: number;
  status: WeekProgress['status'];
}

/** The first week still in progress; if none is, the last week that is open; null when nothing is open. */
export function thisWeek(weeks: readonly WeekProgress[]): ThisWeek | null {
  const week = weeks.find((candidate) => candidate.status === 'IN_PROGRESS') ?? [...weeks].reverse().find((candidate) => candidate.open) ?? null;
  return week
    ? { id: week.id, position: week.position, title: week.title, lessonsDone: week.lessonsDone, lessonsTotal: week.lessonsTotal, status: week.status }
    : null;
}

/** What the dashboard needs to know about one submission. */
export interface SubmissionLike {
  status: 'SUBMITTED' | 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';
  versionCount: number;
  review: { reviewedAt: Date } | null;
}

export interface NextAssignment {
  weekIndex: number;
  status: 'NOT_SUBMITTED' | 'NEEDS_REVISION';
}

/**
 * The first assignment (in course order, in a week that is open) that still needs her: not sent
 * yet, or sent back for changes. Assignments she has sent and that wait for review do not count.
 */
export function nextAssignment(
  snapshot: Snapshot,
  weeks: readonly WeekProgress[],
  submissions: ReadonlyMap<string, SubmissionLike>,
): NextAssignment | null {
  for (let index = 0; index < snapshot.weeks.length; index++) {
    const assignment = snapshot.weeks[index].assignment;
    if (!weeks[index]?.open || !assignment) continue;

    const submission = submissions.get(assignment.id);
    if (!submission) return { weekIndex: index, status: 'NOT_SUBMITTED' };
    if (submission.status === 'NEEDS_REVISION') return { weekIndex: index, status: 'NEEDS_REVISION' };
  }
  return null;
}

export interface JoinWindow {
  opensAt: Date;
  endsAt: Date;
  joinable: boolean;
}

/** The join link may be shown from 10 minutes before the start until the class ends. */
export function joinWindow(startsAt: Date, durationMinutes: number, now: Date): JoinWindow {
  const opensAt = new Date(startsAt.getTime() - JOIN_OPENS_MINUTES_BEFORE * MINUTE_MS);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * MINUTE_MS);
  return { opensAt, endsAt, joinable: now.getTime() >= opensAt.getTime() && now.getTime() < endsAt.getTime() };
}

export interface NextClass {
  weekPosition: number;
  weekTitle: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  notes: string | null;
  joinable: boolean;
  joinOpensAt: Date;
  /** Present ONLY while the join window is open (10 minutes before until the end); otherwise null. */
  joinUrl: string | null;
}

export interface LastClass {
  weekPosition: number;
  weekTitle: string;
  startsAt: Date;
  durationMinutes: number;
}

/** The next class that has not finished yet, and the most recent one that has. */
export function liveClasses(snapshot: Snapshot, now: Date): { next: NextClass | null; last: LastClass | null } {
  const classes = snapshot.weeks.flatMap((week, index) =>
    week.classSession
      ? [{ week, position: index + 1, session: week.classSession, startsAt: new Date(week.classSession.startsAt) }]
      : [],
  );
  classes.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const ends = (item: (typeof classes)[number]) => item.startsAt.getTime() + item.session.durationMinutes * MINUTE_MS;
  const upcoming = classes.find((item) => ends(item) > now.getTime()) ?? null;
  const held = [...classes].reverse().find((item) => ends(item) <= now.getTime()) ?? null;

  let next: NextClass | null = null;
  if (upcoming) {
    const window = joinWindow(upcoming.startsAt, upcoming.session.durationMinutes, now);
    next = {
      weekPosition: upcoming.position,
      weekTitle: upcoming.week.title,
      startsAt: upcoming.startsAt,
      endsAt: window.endsAt,
      durationMinutes: upcoming.session.durationMinutes,
      notes: upcoming.session.notes,
      joinable: window.joinable,
      joinOpensAt: window.opensAt,
      joinUrl: window.joinable ? upcoming.session.joinUrl : null,
    };
  }

  const last: LastClass | null = held
    ? { weekPosition: held.position, weekTitle: held.week.title, startsAt: held.startsAt, durationMinutes: held.session.durationMinutes }
    : null;
  return { next, last };
}

export interface Journey {
  lessonsDone: number;
  lessonsTotal: number;
  assignmentsTotal: number;
  assignmentsCompleted: number;
  assignmentsRevised: number;
  capstone: { title: string; reviewedAt: Date | null } | null;
}

/** "Your journey" for a student who finished the course. The capstone is the LAST week's assignment. */
export function journey(
  snapshot: Snapshot,
  lessonsDone: number,
  lessonsTotal: number,
  submissions: ReadonlyMap<string, SubmissionLike>,
): Journey {
  const assignments = snapshot.weeks.flatMap((week) => (week.assignment ? [week.assignment] : []));
  const lastWeek = snapshot.weeks[snapshot.weeks.length - 1];
  const capstone = lastWeek?.assignment ?? null;

  return {
    lessonsDone,
    lessonsTotal,
    assignmentsTotal: assignments.length,
    assignmentsCompleted: assignments.filter((assignment) => submissions.get(assignment.id)?.status === 'COMPLETED').length,
    assignmentsRevised: assignments.filter((assignment) => (submissions.get(assignment.id)?.versionCount ?? 0) > 1).length,
    capstone: capstone ? { title: capstone.title, reviewedAt: submissions.get(capstone.id)?.review?.reviewedAt ?? null } : null,
  };
}
EOF

# ============================================================================
cat > src/learning/dashboard.service.ts <<'EOF'
/**
 * dashboard.service.ts  (the student's side)
 * ---------------------------------------------------------------------------
 * The learning dashboard: everything a student who is learning (or who has finished) needs on
 * her home screen, in ONE call.
 *
 *   - her track, cohort and instructor(s);
 *   - course progress: lessons done, the percentage, and weeks completed (a week counts only
 *     when its lessons are done AND its assignment was reviewed);
 *   - "Continue learning" (the next lesson) and "this week";
 *   - the feedback-ready card: her latest review (assignment, instructor, date, outcome);
 *   - "your next assignment": title, week, due time (exact instant + timezone) and status;
 *   - live classes: the next one and the last one held. The JOIN LINK is sent only from 10
 *     minutes before the class until it ends - the server enforces it, so it cannot be
 *     read early by looking at the response;
 *   - her goal, her latest badge and badge count, and her 5 latest activity lines;
 *   - for a student who finished the course: her "journey" summary.
 *
 * The pending, declined and accepted states are served by GET /students/me/dashboard (the
 * admissions dashboard); this one is for students whose course is open.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';

import { ActivityService } from '../achievements/activity.service';
import type { ActivityQuery } from '../achievements/dto/activity.query';
import { BadgesService } from '../achievements/badges.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { formatCalendarDate } from '../catalog/catalog.util';
import { branding } from '../config/branding.config';
import { PrismaService } from '../prisma/prisma.service';
import { phaseAt, scheduleFor } from './assignment-rules';
import { journey, liveClasses, nextAssignment, thisWeek, weeksCompleted } from './dashboard-rules';
import { OUTCOME_LABEL } from './feedback-view';
import { LearningAccessService } from './learning-access.service';
import { cohortNotStartedMessage, NOT_OPEN_MESSAGE, NOT_READY_MESSAGE } from './learning.constants';
import { findNextLesson, summarizeProgress } from './learning-rules';
import { ProgressStateService } from './progress-state.service';
import { PublishedCourseService } from './published-course.service';
import { SubmissionsService } from './submissions.service';

/** How many activity lines the dashboard shows (the full list is GET /learn/activity). */
const RECENT_ACTIVITY = 5;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
    private readonly submissions: SubmissionsService,
    private readonly badges: BadgesService,
    private readonly activity: ActivityService,
  ) {}

  async get(user: AuthenticatedUser) {
    const access = await this.access.resolve(user);

    if (access.kind === 'NO_ENROLLMENT') throw new ForbiddenException(NOT_OPEN_MESSAGE);
    if (access.kind === 'NOT_STARTED') {
      return {
        state: 'COHORT_NOT_STARTED' as const,
        message: cohortNotStartedMessage(formatCalendarDate(access.cohort.startsOn)),
        cohort: { id: access.cohort.id, name: access.cohort.name, startsOn: formatCalendarDate(access.cohort.startsOn) },
      };
    }
    if (access.kind === 'NOT_READY') {
      return { state: 'CONTENT_NOT_READY' as const, message: NOT_READY_MESSAGE, cohort: { id: access.cohort.id, name: access.cohort.name } };
    }

    const { context } = access;
    const now = new Date();
    const snapshot = await this.published.get(context.contentId, context.version);

    const [state, summaries, who, latestReview, profile, badgeList] = await Promise.all([
      this.progress.load(this.prisma, context.enrollmentId, snapshot),
      this.submissions.summaries(context.enrollmentId),
      this.prisma.enrollment.findUniqueOrThrow({
        where: { id: context.enrollmentId },
        select: {
          student: { select: { fullName: true } },
          cohort: {
            select: {
              name: true,
              course: { select: { title: true, track: { select: { name: true } } } },
              instructors: { select: { instructor: { select: { fullName: true } } } },
            },
          },
        },
      }),
      this.prisma.submissionReview.findFirst({
        where: { version: { submission: { enrollmentId: context.enrollmentId } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          outcome: true,
          createdAt: true,
          reviewerId: true,
          version: { select: { submission: { select: { assignmentId: true } } } },
        },
      }),
      this.prisma.studentProfile.findUnique({ where: { userId: user.id }, select: { goal: true } }),
      // Also does the one-time catch-up of her activity log and badges.
      this.badges.list(context.enrollmentId),
    ]);

    const weeks = this.progress.evaluate(snapshot, state, context.readOnly);
    const summary = summarizeProgress(weeks);

    // The next assignment, with its due time worked out from the week's live class.
    const next = nextAssignment(snapshot, weeks, summaries);
    let nextAssignmentView = null;
    if (next) {
      const week = snapshot.weeks[next.weekIndex];
      const assignment = week.assignment!;
      const schedule = scheduleFor(week.classSession ? new Date(week.classSession.startsAt) : null);
      nextAssignmentView = {
        id: assignment.id,
        title: assignment.title,
        expectedMinutes: assignment.expectedMinutes,
        week: { id: week.id, position: next.weekIndex + 1, title: week.title },
        status: next.status,
        dueAt: schedule.dueAt,
        closesAt: schedule.closesAt,
        phase: phaseAt(schedule, now),
      };
    }

    // The feedback-ready card: her latest review.
    let latestFeedback = null;
    if (latestReview) {
      const assignmentId = latestReview.version.submission.assignmentId;
      const week = snapshot.weeks.find((candidate) => candidate.assignment?.id === assignmentId);
      const reviewer = await this.prisma.user.findUnique({ where: { id: latestReview.reviewerId }, select: { fullName: true } });
      latestFeedback = {
        assignmentId,
        assignmentTitle: week?.assignment?.title ?? 'Assignment',
        outcome: latestReview.outcome,
        outcomeLabel: OUTCOME_LABEL[latestReview.outcome],
        reviewedAt: latestReview.createdAt,
        reviewer: { fullName: reviewer?.fullName ?? 'Your instructor' },
      };
    }

    const activityPage = await this.activity.feed(context.enrollmentId, { page: 1, pageSize: RECENT_ACTIVITY } as ActivityQuery);

    return {
      state: context.readOnly ? ('COMPLETED' as const) : ('LEARNING' as const),
      timezone: branding.timezone,
      student: { fullName: who.student.fullName },
      track: who.cohort.course.track.name,
      course: who.cohort.course.title,
      cohort: who.cohort.name,
      instructors: who.cohort.instructors.map((row) => row.instructor.fullName),
      progress: {
        lessonsDone: summary.lessonsDone,
        lessonsTotal: summary.lessonsTotal,
        percent: summary.percent,
        weeksCompleted: weeksCompleted(snapshot, weeks, state.graded),
        weeksTotal: summary.weeksTotal,
      },
      continueLearning: findNextLesson(weeks),
      thisWeek: thisWeek(weeks),
      nextAssignment: nextAssignmentView,
      latestFeedback,
      liveClass: liveClasses(snapshot, now),
      goal: profile?.goal ?? null,
      badges: {
        latest: badgeList.earned.length > 0 ? badgeList.earned[badgeList.earned.length - 1] : null,
        count: badgeList.counts.earned,
        total: badgeList.counts.total,
      },
      recentActivity: activityPage.items,
      journey: context.readOnly ? journey(snapshot, summary.lessonsDone, summary.lessonsTotal, summaries) : null,
    };
  }
}
EOF

cat > src/learning/dashboard.controller.ts <<'EOF'
/**
 * dashboard.controller.ts  (students only)
 * ---------------------------------------------------------------------------
 *   GET /api/v1/learn/dashboard   the learning dashboard for a student whose course is open
 *
 * (Pending, declined and accepted students use GET /api/v1/students/me/dashboard.)
 */
import { Controller, Get } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';

@Roles(Role.STUDENT)
@Controller('learn')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboard.get(user);
  }
}
EOF

# ============================================================================
# Changed file (rewritten in full): the learning module now also provides the dashboard
cat > src/learning/learning.module.ts <<'EOF'
/**
 * learning.module.ts
 * ---------------------------------------------------------------------------
 * The student's learning experience: the course overview, lessons, completion,
 * video resume, assignments and submissions, the learning dashboard, and opening a week early
 * for one student.
 *
 * It relies on the ownership rule registered by CourseContentModule
 * ("course-content.manage") for the early-open action, so both modules must be
 * part of the application (they are, in AppModule). File storage and signed links come
 * from the shared PlatformModule (src/platform), which is global.
 *
 * It uses AchievementsModule to record activity and award badges.
 * ProgressStateService, SubmissionFilesService and the published-course reader are exported
 * because the grading module uses them too.
 */
import { Module } from '@nestjs/common';

import { AchievementsModule } from '../achievements/achievements.module';
import { AuthModule } from '../auth/auth.module';
import { AssignmentContextService } from './assignment-context.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { EnrollmentUnlockController } from './enrollment-unlock.controller';
import { LearningAccessService } from './learning-access.service';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { ProgressStateService } from './progress-state.service';
import { PublishedCourseModule } from './published-course.module';
import { SubmissionFilesService } from './submission-files.service';
import { SubmissionsService } from './submissions.service';
import { WeekUnlockService } from './week-unlock.service';

@Module({
  imports: [AuthModule, PublishedCourseModule, AchievementsModule],
  controllers: [LearningController, AssignmentsController, DashboardController, EnrollmentUnlockController],
  providers: [
    LearningAccessService,
    ProgressStateService,
    LearningService,
    AssignmentContextService,
    AssignmentsService,
    DashboardService,
    SubmissionFilesService,
    SubmissionsService,
    WeekUnlockService,
  ],
  exports: [PublishedCourseModule, ProgressStateService, SubmissionFilesService],
})
export class LearningModule {}
EOF

echo "Batch 5B files created. Now replace the two files shown below the script."