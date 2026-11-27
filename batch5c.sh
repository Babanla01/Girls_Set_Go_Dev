#!/usr/bin/env bash
# Batch 5C - the instructor workspace: dashboard, students list (with CSV export), student detail.
# Run from the repo root. (No database change in this batch.)
set -euo pipefail
cd backend
mkdir -p src/instructor/workspace/dto

# ============================================================================
cat > src/instructor/workspace/workspace.constants.ts <<'EOF'
/**
 * workspace.constants.ts
 * ---------------------------------------------------------------------------
 * The numbers and sentences of the instructor workspace, in ONE place.
 */
import { branding } from '../../config/branding.config';

/** A student who has been quiet this long is flagged "Needs attention". */
export const ATTENTION_AFTER_DAYS = 7;

/** ... and "Inactive" when she has been quiet this long. */
export const INACTIVE_AFTER_DAYS = 21;

/** A student who was asked for changes needs attention when her resubmit date is this close (or past). */
export const REVISION_DEADLINE_WARNING_DAYS = 2;

/** How many submissions the dashboard's review queue shows (the full list is the grading inbox). */
export const QUEUE_SIZE = 5;

/** How many activity lines a student's detail shows. */
export const RECENT_ACTIVITY = 8;

/** The most students one CSV export may contain. */
export const EXPORT_MAX_ROWS = 5000;

/** Shown (with a 403) when an instructor opens a student outside her cohorts. */
export const OUT_OF_SCOPE_MESSAGE =
  "This student isn't in your cohorts. You can only open students, lessons and submissions for the courses and cohorts you're assigned to. If you should have access, ask an admin to update your teaching scope.";

/** Instructors never message students directly (they are minors): they go through support. */
export const SUPPORT_MESSAGE =
  'Instructors do not message students directly. To reach a student or her family, write to support and they will help.';

export const SUPPORT_EMAIL = branding.supportEmail;
EOF

# ============================================================================
cat > src/instructor/workspace/student-status.ts <<'EOF'
/**
 * student-status.ts
 * ---------------------------------------------------------------------------
 * The status label an instructor sees for a student, as one pure function (no database):
 *
 *   NEEDS_REVIEW     she has work waiting for an instructor
 *   INACTIVE         nothing waiting, and no activity for 21 days or more
 *   NEEDS_ATTENTION  nothing waiting, no activity for 7 days or more - or she was asked for
 *                    changes and her resubmit date is within 2 days (or already past)
 *   ON_TRACK         everything else
 *
 * Checked in that order (so "Inactive" wins over "Needs attention").
 */
import { ATTENTION_AFTER_DAYS, INACTIVE_AFTER_DAYS, REVISION_DEADLINE_WARNING_DAYS } from './workspace.constants';

export const STUDENT_STATUSES = ['NEEDS_REVIEW', 'NEEDS_ATTENTION', 'ON_TRACK', 'INACTIVE'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const STATUS_LABEL: Record<StudentStatus, string> = {
  NEEDS_REVIEW: 'Needs review',
  NEEDS_ATTENTION: 'Needs attention',
  ON_TRACK: 'On track',
  INACTIVE: 'Inactive',
};

/** The order of the students list: the ones who need someone first. */
export const STATUS_PRIORITY: Record<StudentStatus, number> = {
  NEEDS_REVIEW: 0,
  NEEDS_ATTENTION: 1,
  INACTIVE: 2,
  ON_TRACK: 3,
};

export interface StatusInput {
  /** Submissions waiting for review. */
  waitingForReview: number;
  /** The earliest resubmit date among the work sent back for changes (null when none). */
  revisionDeadline: Date | null;
  /** The last sign of life (or the day she joined / the cohort started when there is none yet). */
  lastActivityAt: Date;
  now: Date;
}

const DAY_MS = 86_400_000;

export function studentStatus(input: StatusInput): StudentStatus {
  if (input.waitingForReview > 0) return 'NEEDS_REVIEW';

  const quietDays = (input.now.getTime() - input.lastActivityAt.getTime()) / DAY_MS;
  if (quietDays >= INACTIVE_AFTER_DAYS) return 'INACTIVE';
  if (quietDays >= ATTENTION_AFTER_DAYS) return 'NEEDS_ATTENTION';

  if (input.revisionDeadline && input.revisionDeadline.getTime() - input.now.getTime() <= REVISION_DEADLINE_WARNING_DAYS * DAY_MS) {
    return 'NEEDS_ATTENTION';
  }
  return 'ON_TRACK';
}
EOF

# ============================================================================
cat > src/instructor/workspace/student-metrics.ts <<'EOF'
/**
 * student-metrics.ts
 * ---------------------------------------------------------------------------
 * The numbers shown for ONE student in the instructor's lists, worked out from facts that were
 * already read from the database. Pure (no database), so it is easy to test.
 *
 *  - lessons done / total / percent: only lessons that are STILL in the live course count, so a
 *    lesson removed from the course later can never push a student past 100%;
 *  - submission counts: sent, waiting for review, sent back for changes, completed;
 *  - last activity: the most recent lesson she completed or version she sent;
 *  - status: see student-status.ts.
 */
import { studentStatus, StudentStatus } from './student-status';

export interface SubmissionFact {
  status: 'SUBMITTED' | 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';
  revisionOpenUntil: Date | null;
  /** When her latest version was sent. */
  lastVersionAt: Date | null;
}

export interface MetricsInput {
  enrolledAt: Date;
  cohortStartsOn: Date;
  /** The ids of every lesson in the live course (null when nothing is published yet). */
  courseLessonIds: ReadonlySet<string> | null;
  /** lesson id -> when she completed it. */
  completed: ReadonlyMap<string, Date>;
  submissions: readonly SubmissionFact[];
  now: Date;
}

export interface StudentMetrics {
  lessonsDone: number;
  lessonsTotal: number;
  percent: number;
  submissions: { total: number; waiting: number; needsRevision: number; completed: number };
  /** The last thing she actually did (null when she has done nothing yet). */
  lastActivityAt: Date | null;
  status: StudentStatus;
}

const latestOf = (dates: readonly Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.max(...dates.map((date) => date.getTime())));

export function computeMetrics(input: MetricsInput): StudentMetrics {
  const lessonsTotal = input.courseLessonIds ? input.courseLessonIds.size : 0;
  const lessonsDone = input.courseLessonIds ? [...input.completed.keys()].filter((id) => input.courseLessonIds!.has(id)).length : 0;
  const percent = lessonsTotal > 0 ? Math.round((lessonsDone * 100) / lessonsTotal) : 0;

  const submissions = {
    total: input.submissions.length,
    waiting: input.submissions.filter((row) => row.status === 'SUBMITTED').length,
    needsRevision: input.submissions.filter((row) => row.status === 'NEEDS_REVISION').length,
    completed: input.submissions.filter((row) => row.status === 'COMPLETED').length,
  };

  const lastActivityAt = latestOf([
    ...input.completed.values(),
    ...input.submissions.flatMap((row) => (row.lastVersionAt ? [row.lastVersionAt] : [])),
  ]);

  // Before she has done anything, "quiet" is counted from the day she joined or the cohort started, whichever is later.
  const base = input.enrolledAt.getTime() > input.cohortStartsOn.getTime() ? input.enrolledAt : input.cohortStartsOn;
  const reference = lastActivityAt && lastActivityAt.getTime() > base.getTime() ? lastActivityAt : base;

  const deadlines = input.submissions.flatMap((row) => (row.status === 'NEEDS_REVISION' && row.revisionOpenUntil ? [row.revisionOpenUntil] : []));
  const revisionDeadline = deadlines.length === 0 ? null : new Date(Math.min(...deadlines.map((date) => date.getTime())));

  return {
    lessonsDone,
    lessonsTotal,
    percent,
    submissions,
    lastActivityAt,
    status: studentStatus({ waitingForReview: submissions.waiting, revisionDeadline, lastActivityAt: reference, now: input.now }),
  };
}

/** The average of whole-number percentages, rounded (0 when there are no students). */
export function averagePercent(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
EOF

# ============================================================================
cat > src/instructor/workspace/csv.ts <<'EOF'
/**
 * csv.ts
 * ---------------------------------------------------------------------------
 * Builds a CSV file that is SAFE to open in a spreadsheet. Pure functions.
 *
 *  - A text value that starts with "=", "+", "-", "@" (or a tab / carriage return) would be run
 *    as a FORMULA by Excel or Google Sheets - a known attack when names come from users. Such a
 *    value gets a leading apostrophe, which makes the spreadsheet treat it as plain text.
 *    (Real numbers are written as they are, so a negative number stays a number.)
 *  - Values containing commas, quotes or line breaks are quoted, and quotes are doubled.
 *  - Lines end with CRLF, and the file starts with a BOM so Excel reads accents correctly.
 */
export type CsvValue = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);

  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly (readonly CsvValue[])[]): string {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
EOF

# ============================================================================
cat > src/instructor/workspace/workspace-rules.ts <<'EOF'
/**
 * workspace-rules.ts
 * ---------------------------------------------------------------------------
 * Small pure rules used by the instructor dashboard and the student detail (no database):
 *   - which week of the course a cohort is "in" today;
 *   - the state of a week for the instructor (Complete / Waiting for review / In progress / Locked);
 *   - whether saving a review would OPEN the student's next week (the dashboard says so).
 */
import type { Snapshot } from '../../course-content/snapshot';
import { evaluateWeeks, WeekProgress } from '../../learning/learning-rules';
import type { ProgressState } from '../../learning/progress-state.service';

const DAY_MS = 86_400_000;

/**
 * "Week 2 of 8": the cohort's week counted from its start date (a new week every 7 days),
 * never below 1 or above the number of weeks. Null before the cohort starts, or when the course
 * has no published weeks yet.
 */
export function cohortWeek(startsOn: Date, totalWeeks: number | null, now: Date): number | null {
  if (!totalWeeks || totalWeeks < 1) return null;
  const days = Math.floor((now.getTime() - startsOn.getTime()) / DAY_MS);
  if (days < 0) return null;
  return Math.min(Math.floor(days / 7) + 1, totalWeeks);
}

export type WeekState = 'LOCKED' | 'IN_PROGRESS' | 'WAITING' | 'COMPLETE';

/**
 * Locked weeks are locked. A week whose lessons are all done is COMPLETE once its assignment
 * has been reviewed, and WAITING (for review) until then. Anything else open is IN_PROGRESS.
 */
export function weekState(week: WeekProgress, graded: boolean): WeekState {
  if (!week.open) return 'LOCKED';
  if (week.status === 'COMPLETE') return graded ? 'COMPLETE' : 'WAITING';
  return 'IN_PROGRESS';
}

/**
 * Would saving a review for this week's assignment open a week that is closed today? It runs the
 * REAL unlock rules twice - as things are, and with this week counted as reviewed - so the
 * answer can never disagree with what saving the review actually does.
 */
export function wouldOpenNextWeek(snapshot: Snapshot, state: ProgressState, weekId: string): boolean {
  const before = evaluateWeeks(snapshot, { completed: state.completed, unlocked: state.unlocked, gradedWeeks: state.graded });
  const after = evaluateWeeks(snapshot, {
    completed: state.completed,
    unlocked: state.unlocked,
    gradedWeeks: new Set([...state.graded, weekId]),
  });
  return after.some((week, index) => week.open && !before[index].open);
}
EOF

# ============================================================================
cat > src/instructor/workspace/dto/students.query.ts <<'EOF'
/**
 * students.query.ts
 * ---------------------------------------------------------------------------
 *   ?search=ada                          part of a student's name
 *   &courseId=<uuid>&cohortId=<uuid>     narrow to one course / cohort
 *   &status=NEEDS_REVIEW|NEEDS_ATTENTION|ON_TRACK|INACTIVE|ALL   (default ALL)
 *   &page=1&pageSize=20                  (the CSV export ignores paging)
 */
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../common/pagination/pagination';
import { STUDENT_STATUSES } from '../student-status';

export const STUDENT_STATUS_FILTERS = [...STUDENT_STATUSES, 'ALL'] as const;
export type StudentStatusFilter = (typeof STUDENT_STATUS_FILTERS)[number];

export class StudentsQuery extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @IsOptional()
  @IsIn(STUDENT_STATUS_FILTERS)
  status?: StudentStatusFilter;
}
EOF

# ============================================================================
cat > src/instructor/workspace/roster.service.ts <<'EOF'
/**
 * roster.service.ts
 * ---------------------------------------------------------------------------
 * "Which students may this person see, and how are they doing?" - the ONE place that answers it
 * for the instructor dashboard, the students list and the CSV export.
 *
 *  - SCOPE: an admin sees every current cohort; an instructor only the cohorts assigned to her
 *    (read from the database on every request, so removing an assignment takes effect at once).
 *  - Current cohorts only (planned or active), and only students who are learning now (ACTIVE).
 *  - Numbers come from a handful of batch queries for ALL the students at once - never one
 *    query per student - and are worked out by student-metrics.ts.
 */
import { Injectable } from '@nestjs/common';
import { CohortStatus, EnrollmentStatus, Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { GradingScopeService } from '../../grading/grading-scope.service';
import { PublishedCourseService } from '../../learning/published-course.service';
import { PrismaService } from '../../prisma/prisma.service';
import { computeMetrics, StudentMetrics } from './student-metrics';

/** What is read about a cohort. */
export const cohortSelect = {
  id: true,
  name: true,
  startsOn: true,
  endsOn: true,
  status: true,
  course: { select: { id: true, title: true, track: { select: { name: true } } } },
  courseContent: { select: { id: true, publishedVersion: true } },
} satisfies Prisma.CohortSelect;

export type CohortInfo = Prisma.CohortGetPayload<{ select: typeof cohortSelect }>;

export interface RosterRow {
  enrollmentId: string;
  reference: string;
  enrolledAt: Date;
  student: { id: string; fullName: string };
  cohort: CohortInfo;
  metrics: StudentMetrics;
}

@Injectable()
export class RosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: GradingScopeService,
    private readonly published: PublishedCourseService,
  ) {}

  /** The cohorts she may see (with the optional course / cohort narrowing) and every learning student in them. */
  async load(
    user: AuthenticatedUser,
    filters: { courseId?: string; cohortId?: string } = {},
    now: Date = new Date(),
  ): Promise<{ cohorts: CohortInfo[]; rows: RosterRow[] }> {
    const scopeIds = await this.scope.cohortIds(user);
    if (scopeIds !== null && scopeIds.length === 0) return { cohorts: [], rows: [] };

    const and: Prisma.CohortWhereInput[] = [{ status: { in: [CohortStatus.PLANNED, CohortStatus.ACTIVE] } }];
    if (scopeIds !== null) and.push({ id: { in: scopeIds } });
    if (filters.courseId) and.push({ courseId: filters.courseId });
    if (filters.cohortId) and.push({ id: filters.cohortId });

    const cohorts = await this.prisma.cohort.findMany({
      where: { AND: and },
      orderBy: [{ startsOn: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: cohortSelect,
    });
    if (cohorts.length === 0) return { cohorts, rows: [] };

    const enrollments = await this.prisma.enrollment.findMany({
      where: { status: EnrollmentStatus.ACTIVE, cohortId: { in: cohorts.map((cohort) => cohort.id) } },
      orderBy: [{ enrolledAt: 'asc' }, { id: 'asc' }],
      select: { id: true, reference: true, enrolledAt: true, cohortId: true, student: { select: { id: true, fullName: true } } },
    });

    const cohortById = new Map(cohorts.map((cohort) => [cohort.id, cohort]));
    const metrics = await this.metricsFor(enrollments, cohortById, now);

    const rows = enrollments.flatMap((enrollment) => {
      const cohort = cohortById.get(enrollment.cohortId);
      const numbers = metrics.get(enrollment.id);
      if (!cohort || !numbers) return [];
      return [
        { enrollmentId: enrollment.id, reference: enrollment.reference, enrolledAt: enrollment.enrolledAt, student: enrollment.student, cohort, metrics: numbers },
      ];
    });
    return { cohorts, rows };
  }

  /** Lessons done, submissions and status for each enrollment - from three batch queries. */
  async metricsFor(
    enrollments: readonly { id: string; enrolledAt: Date; cohortId: string }[],
    cohortById: ReadonlyMap<string, CohortInfo>,
    now: Date,
  ): Promise<Map<string, StudentMetrics>> {
    // The lessons of each cohort's LIVE course (none when nothing is published).
    const lessonSets = new Map<string, Set<string> | null>();
    for (const cohort of cohortById.values()) {
      const content = cohort.courseContent;
      if (!content || content.publishedVersion === null) {
        lessonSets.set(cohort.id, null);
        continue;
      }
      const snapshot = await this.published.get(content.id, content.publishedVersion).catch(() => null);
      lessonSets.set(cohort.id, snapshot ? new Set(snapshot.weeks.flatMap((week) => week.lessons.map((lesson) => lesson.id))) : null);
    }

    const ids = enrollments.map((enrollment) => enrollment.id);
    const [progress, submissions] = await Promise.all([
      this.prisma.lessonProgress.findMany({
        where: { enrollmentId: { in: ids }, completedAt: { not: null } },
        select: { enrollmentId: true, lessonId: true, completedAt: true },
      }),
      this.prisma.submission.findMany({
        where: { enrollmentId: { in: ids } },
        select: {
          enrollmentId: true,
          status: true,
          revisionOpenUntil: true,
          versions: { orderBy: { number: 'desc' }, take: 1, select: { createdAt: true } },
        },
      }),
    ]);

    const completedBy = new Map<string, Map<string, Date>>();
    for (const row of progress) {
      if (!row.completedAt) continue;
      const map = completedBy.get(row.enrollmentId) ?? new Map<string, Date>();
      map.set(row.lessonId, row.completedAt);
      completedBy.set(row.enrollmentId, map);
    }
    const submissionsBy = new Map<string, typeof submissions>();
    for (const row of submissions) submissionsBy.set(row.enrollmentId, [...(submissionsBy.get(row.enrollmentId) ?? []), row]);

    const result = new Map<string, StudentMetrics>();
    for (const enrollment of enrollments) {
      const cohort = cohortById.get(enrollment.cohortId);
      if (!cohort) continue;
      result.set(
        enrollment.id,
        computeMetrics({
          enrolledAt: enrollment.enrolledAt,
          cohortStartsOn: cohort.startsOn,
          courseLessonIds: lessonSets.get(cohort.id) ?? null,
          completed: completedBy.get(enrollment.id) ?? new Map(),
          submissions: (submissionsBy.get(enrollment.id) ?? []).map((row) => ({
            status: row.status,
            revisionOpenUntil: row.revisionOpenUntil,
            lastVersionAt: row.versions[0]?.createdAt ?? null,
          })),
          now,
        }),
      );
    }
    return result;
  }
}
EOF

# ============================================================================
cat > src/instructor/workspace/instructor-students.service.ts <<'EOF'
/**
 * instructor-students.service.ts
 * ---------------------------------------------------------------------------
 * The instructor's STUDENTS: the list, the CSV export, and one student's detail.
 *
 *  LIST    Her cohorts' learning students with search, course / cohort / status filters and paging.
 *          Sorted so the students who need someone come first (needs review, needs attention,
 *          inactive, on track), then by name. The tab counts always cover everything she may see
 *          for the chosen course / cohort - not only the current page, search or status.
 *  EXPORT  The same filtered list as a CSV. Only names and learning numbers: never a phone,
 *          email, school, date of birth or guardian detail. Safe to open in a spreadsheet, capped
 *          at 5,000 rows, and written to the audit log (counts and filters only, never names).
 *  DETAIL  One student: progress, week by week, assignment history, badges, her goal and
 *          interests (read-only), recent activity, and how to reach support. A student outside
 *          the instructor's cohorts gets the same plain 403 as a student that does not exist, so
 *          nobody can find out who exists by guessing - and no student data.
 *
 * Interests and goals are visible to the student, her instructors and admins (PRF-03). Phone,
 * school, date of birth and guardian details are admin-only and are never read here.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';

import { ActivityService } from '../../achievements/activity.service';
import type { ActivityQuery } from '../../achievements/dto/activity.query';
import { BadgesService } from '../../achievements/badges.service';
import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { AuditService } from '../../common/audit/audit.service';
import { buildPage } from '../../common/pagination/pagination';
import { branding } from '../../config/branding.config';
import { GradingScopeService } from '../../grading/grading-scope.service';
import { weeksCompleted } from '../../learning/dashboard-rules';
import { OUTCOME_LABEL } from '../../learning/feedback-view';
import { ProgressStateService } from '../../learning/progress-state.service';
import { PublishedCourseService } from '../../learning/published-course.service';
import { PrismaService } from '../../prisma/prisma.service';
import { initialsOf } from '../../profile/profile-rules';
import { toCsv } from './csv';
import type { StudentsQuery } from './dto/students.query';
import { cohortSelect, RosterRow, RosterService } from './roster.service';
import { STATUS_LABEL, STATUS_PRIORITY } from './student-status';
import {
  EXPORT_MAX_ROWS,
  OUT_OF_SCOPE_MESSAGE,
  RECENT_ACTIVITY,
  SUPPORT_EMAIL,
  SUPPORT_MESSAGE,
} from './workspace.constants';
import { weekState } from './workspace-rules';

@Injectable()
export class InstructorStudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roster: RosterService,
    private readonly scope: GradingScopeService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
    private readonly badges: BadgesService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------- list

  async list(user: AuthenticatedUser, query: StudentsQuery) {
    const { cohorts, rows } = await this.roster.load(user, { courseId: query.courseId, cohortId: query.cohortId });

    const counts = {
      needsReview: rows.filter((row) => row.metrics.status === 'NEEDS_REVIEW').length,
      needsAttention: rows.filter((row) => row.metrics.status === 'NEEDS_ATTENTION').length,
      onTrack: rows.filter((row) => row.metrics.status === 'ON_TRACK').length,
      inactive: rows.filter((row) => row.metrics.status === 'INACTIVE').length,
      total: rows.length,
    };

    const visible = this.filtered(rows, query);
    const start = (query.page - 1) * query.pageSize;
    const items = visible.slice(start, start + query.pageSize).map((row) => this.listItem(row));

    return {
      ...buildPage(items, visible.length, query),
      status: query.status ?? 'ALL',
      counts,
      // For the filter dropdowns: the courses and cohorts she may choose from.
      filters: {
        courses: [...new Map(cohorts.map((cohort) => [cohort.course.id, { id: cohort.course.id, title: cohort.course.title }])).values()],
        cohorts: cohorts.map((cohort) => ({ id: cohort.id, name: cohort.name, courseId: cohort.course.id })),
      },
    };
  }

  // ------------------------------------------------------------------ export

  /** The CSV text, ready to send. */
  async exportCsv(user: AuthenticatedUser, query: StudentsQuery, context: RequestContext): Promise<string> {
    const { rows } = await this.roster.load(user, { courseId: query.courseId, cohortId: query.cohortId });
    const selected = this.filtered(rows, query).slice(0, EXPORT_MAX_ROWS);

    const header = [
      'Student', 'Track', 'Course', 'Cohort', 'Lessons done', 'Lessons total', 'Progress %', 'Status',
      'Submissions sent', 'Waiting for review', 'Needs revision', 'Completed', 'Last activity', 'Joined',
    ];
    const body = selected.map((row) => [
      row.student.fullName,
      row.cohort.course.track.name,
      row.cohort.course.title,
      row.cohort.name,
      row.metrics.lessonsDone,
      row.metrics.lessonsTotal,
      row.metrics.percent,
      STATUS_LABEL[row.metrics.status],
      row.metrics.submissions.total,
      row.metrics.submissions.waiting,
      row.metrics.submissions.needsRevision,
      row.metrics.submissions.completed,
      row.metrics.lastActivityAt ? row.metrics.lastActivityAt.toISOString() : '',
      row.enrolledAt.toISOString(),
    ]);

    // The audit entry holds the numbers and the filters used - never a student's name.
    await this.audit.record({
      actorId: user.id,
      action: 'instructor.students_exported',
      entityType: 'student_list',
      metadata: {
        rows: selected.length,
        truncated: this.filtered(rows, query).length > selected.length,
        courseId: query.courseId ?? null,
        cohortId: query.cohortId ?? null,
        status: query.status ?? 'ALL',
        searched: Boolean(query.search),
      },
      ipAddress: context.ipAddress,
    });

    return toCsv([header, ...body]);
  }

  /** The date in the filename: today in the programme's timezone, like 2026-11-26. */
  fileDate(now: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: branding.timezone }).format(now);
  }

  // ------------------------------------------------------------------ detail

  async detail(user: AuthenticatedUser, enrollmentId: string) {
    const scopeIds = await this.scope.cohortIds(user);

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: {
        id: true,
        reference: true,
        status: true,
        enrolledAt: true,
        cohortId: true,
        student: {
          select: {
            id: true,
            fullName: true,
            // Only the two things instructors may read. Phone, school, date of birth and guardian details stay admin-only.
            studentProfile: { select: { goal: true, interests: true } },
          },
        },
        cohort: { select: { ...cohortSelect, instructors: { select: { instructor: { select: { fullName: true } } } } } },
      },
    });

    // Outside her scope and "does not exist" look exactly the same to an instructor.
    if (!enrollment) {
      if (scopeIds === null) throw new NotFoundException('Student not found.');
      throw new ForbiddenException(OUT_OF_SCOPE_MESSAGE);
    }
    if (scopeIds !== null && !scopeIds.includes(enrollment.cohortId)) throw new ForbiddenException(OUT_OF_SCOPE_MESSAGE);

    const now = new Date();
    const { instructors, ...cohort } = enrollment.cohort;
    const content = cohort.courseContent;
    const snapshot =
      content && content.publishedVersion !== null ? await this.published.get(content.id, content.publishedVersion).catch(() => null) : null;

    const metricsMap = await this.roster.metricsFor([enrollment], new Map([[cohort.id, cohort]]), now);
    const metrics = metricsMap.get(enrollment.id)!;

    // Week by week, with the same unlock rules the student lives by.
    const state = snapshot ? await this.progress.load(this.prisma, enrollment.id, snapshot) : null;
    const weekRows = snapshot && state ? this.progress.evaluate(snapshot, state, enrollment.status === EnrollmentStatus.COMPLETED) : [];

    // Her submissions, newest version first inside each.
    const submissions = await this.prisma.submission.findMany({
      where: { enrollmentId: enrollment.id },
      select: {
        id: true,
        reference: true,
        assignmentId: true,
        status: true,
        versions: {
          orderBy: { number: 'desc' },
          select: { number: true, createdAt: true, isLate: true, review: { select: { outcome: true, createdAt: true } } },
        },
      },
    });
    const submissionByAssignment = new Map(submissions.map((row) => [row.assignmentId, row]));

    const assignments = [
      ...(snapshot?.weeks.flatMap((week, index) => {
        const assignment = week.assignment;
        if (!assignment) return [];
        const submission = submissionByAssignment.get(assignment.id);
        if (!submission && !weekRows[index]?.open) return []; // a locked week has no history yet
        return [this.assignmentEntry(assignment.id, assignment.title, index + 1, week.title, submission)];
      }) ?? []),
      // Work for an assignment that is no longer in the live course stays visible.
      ...submissions
        .filter((row) => !snapshot?.weeks.some((week) => week.assignment?.id === row.assignmentId))
        .map((row) => this.assignmentEntry(row.assignmentId, 'Assignment (no longer in the course)', null, null, row)),
    ];

    const waiting = assignments.filter((entry) => entry.status === 'SUBMITTED').sort((a, b) => +a.lastSubmittedAt! - +b.lastSubmittedAt!);

    // Badges and recent activity (this also does the one-time catch-up of her log, safe to repeat).
    const badgeList = await this.badges.list(enrollment.id);
    const recent = await this.activity.feed(enrollment.id, { page: 1, pageSize: RECENT_ACTIVITY } as ActivityQuery);

    const profile = enrollment.student.studentProfile;
    return {
      id: enrollment.id,
      reference: enrollment.reference,
      enrollmentStatus: enrollment.status,
      joinedAt: enrollment.enrolledAt,
      timezone: branding.timezone,
      student: { id: enrollment.student.id, fullName: enrollment.student.fullName, initials: initialsOf(enrollment.student.fullName) },
      track: cohort.course.track.name,
      course: { id: cohort.course.id, title: cohort.course.title },
      cohort: { id: cohort.id, name: cohort.name, startsOn: cohort.startsOn },
      instructors: instructors.map((row) => row.instructor.fullName),
      status: { value: metrics.status, label: STATUS_LABEL[metrics.status], lastActivityAt: metrics.lastActivityAt },
      progress: {
        lessonsDone: metrics.lessonsDone,
        lessonsTotal: metrics.lessonsTotal,
        percent: metrics.percent,
        weeksCompleted: snapshot && state ? weeksCompleted(snapshot, weekRows, state.graded) : 0,
        weeksTotal: weekRows.length,
      },
      needsReview: {
        count: waiting.length,
        oldest: waiting[0]
          ? {
              submissionId: waiting[0].submissionId,
              reference: waiting[0].reference,
              assignmentTitle: waiting[0].title,
              weekPosition: waiting[0].week?.position ?? null,
              submittedAt: waiting[0].lastSubmittedAt,
            }
          : null,
      },
      weeks: weekRows.map((week) => ({
        id: week.id,
        position: week.position,
        title: week.title,
        lessonsDone: week.lessonsDone,
        lessonsTotal: week.lessonsTotal,
        state: weekState(week, state?.graded.has(week.id) ?? false),
      })),
      assignments,
      badges: { earned: badgeList.earned, count: badgeList.counts.earned, total: badgeList.counts.total },
      goal: profile?.goal ?? null,
      interests: profile?.interests ?? [],
      recentActivity: recent.items,
      support: { message: SUPPORT_MESSAGE, email: SUPPORT_EMAIL },
    };
  }

  // ----------------------------------------------------------------- helpers

  /** Applies the search and the status filter, then orders the students who need someone first. */
  private filtered(rows: readonly RosterRow[], query: StudentsQuery): RosterRow[] {
    const search = query.search?.toLowerCase();
    const status = query.status && query.status !== 'ALL' ? query.status : null;

    return rows
      .filter((row) => (!status || row.metrics.status === status) && (!search || row.student.fullName.toLowerCase().includes(search)))
      .sort(
        (a, b) =>
          STATUS_PRIORITY[a.metrics.status] - STATUS_PRIORITY[b.metrics.status] ||
          a.student.fullName.localeCompare(b.student.fullName) ||
          a.enrollmentId.localeCompare(b.enrollmentId),
      );
  }

  private listItem(row: RosterRow) {
    return {
      enrollmentId: row.enrollmentId,
      reference: row.reference,
      joinedAt: row.enrolledAt,
      student: { id: row.student.id, fullName: row.student.fullName, initials: initialsOf(row.student.fullName) },
      track: row.cohort.course.track.name,
      course: { id: row.cohort.course.id, title: row.cohort.course.title },
      cohort: { id: row.cohort.id, name: row.cohort.name },
      lessons: { done: row.metrics.lessonsDone, total: row.metrics.lessonsTotal },
      progressPercent: row.metrics.percent,
      status: row.metrics.status,
      statusLabel: STATUS_LABEL[row.metrics.status],
      submissions: row.metrics.submissions,
      lastActivityAt: row.metrics.lastActivityAt,
    };
  }

  private assignmentEntry(
    assignmentId: string,
    title: string,
    weekPosition: number | null,
    weekTitle: string | null,
    submission?: {
      id: string;
      reference: string;
      status: string;
      versions: { number: number; createdAt: Date; isLate: boolean; review: { outcome: keyof typeof OUTCOME_LABEL; createdAt: Date } | null }[];
    },
  ) {
    const latest = submission?.versions[0];
    const reviewed = submission?.versions.find((version) => version.review !== null);
    return {
      assignmentId,
      title,
      week: weekPosition !== null ? { position: weekPosition, title: weekTitle } : null,
      status: submission ? submission.status : 'NOT_SUBMITTED',
      submissionId: submission?.id ?? null,
      reference: submission?.reference ?? null,
      versions: submission?.versions.length ?? 0,
      isLate: latest?.isLate ?? false,
      lastSubmittedAt: latest?.createdAt ?? null,
      review: reviewed?.review
        ? { outcome: reviewed.review.outcome, outcomeLabel: OUTCOME_LABEL[reviewed.review.outcome], reviewedAt: reviewed.review.createdAt }
        : null,
    };
  }
}
EOF

# ============================================================================
cat > src/instructor/workspace/instructor-dashboard.service.ts <<'EOF'
/**
 * instructor-dashboard.service.ts
 * ---------------------------------------------------------------------------
 * The instructor's home screen, in ONE call:
 *
 *   numbers   courses, active students, needs review, average progress
 *   courses   one card per cohort: course, cohort, "Week 2 of 8", Published or Planned,
 *             "Live now", how many students, average progress, and the start date
 *   queue     the oldest submissions waiting for review (the same list as the grading inbox).
 *             Each says whether saving a review would OPEN that student's next week.
 *
 * An admin sees every current cohort. An instructor with no cohort gets empty numbers and
 * `hasCohorts: false` (the design has no empty state for this yet, so the screen decides).
 */
import { Injectable } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { branding } from '../../config/branding.config';
import { InboxService } from '../../grading/inbox.service';
import type { InboxQuery } from '../../grading/dto/inbox.query';
import { liveClasses } from '../../learning/dashboard-rules';
import { ProgressStateService } from '../../learning/progress-state.service';
import { PublishedCourseService } from '../../learning/published-course.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RosterService } from './roster.service';
import { averagePercent } from './student-metrics';
import { QUEUE_SIZE } from './workspace.constants';
import { cohortWeek, wouldOpenNextWeek } from './workspace-rules';

@Injectable()
export class InstructorDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roster: RosterService,
    private readonly inbox: InboxService,
    private readonly published: PublishedCourseService,
    private readonly progress: ProgressStateService,
  ) {}

  async get(user: AuthenticatedUser) {
    const now = new Date();
    const [{ cohorts, rows }, queue] = await Promise.all([
      this.roster.load(user, {}, now),
      this.inbox.list(user, { status: 'WAITING', page: 1, pageSize: QUEUE_SIZE } as InboxQuery),
    ]);

    // One card per cohort.
    const cards = await Promise.all(
      cohorts.map(async (cohort) => {
        const content = cohort.courseContent;
        const snapshot =
          content && content.publishedVersion !== null ? await this.published.get(content.id, content.publishedVersion).catch(() => null) : null;
        const students = rows.filter((row) => row.cohort.id === cohort.id);
        const running = snapshot ? liveClasses(snapshot, now).next : null;

        return {
          cohortId: cohort.id,
          cohortName: cohort.name,
          cohortStatus: cohort.status,
          course: { id: cohort.course.id, title: cohort.course.title },
          track: cohort.course.track.name,
          published: snapshot !== null,
          liveNow: running !== null && running.startsAt.getTime() <= now.getTime() && now.getTime() < running.endsAt.getTime(),
          week: { current: cohortWeek(cohort.startsOn, snapshot ? snapshot.weeks.length : null, now), total: snapshot ? snapshot.weeks.length : null },
          startsOn: cohort.startsOn,
          students: students.length,
          averageProgress: averagePercent(students.map((row) => row.metrics.percent)),
        };
      }),
    );

    return {
      timezone: branding.timezone,
      hasCohorts: cohorts.length > 0,
      numbers: {
        courses: new Set(cohorts.map((cohort) => cohort.course.id)).size,
        cohorts: cohorts.length,
        activeStudents: rows.length,
        needsReview: queue.counts.waiting,
        averageProgress: averagePercent(rows.map((row) => row.metrics.percent)),
      },
      courses: cards,
      queue: {
        total: queue.total,
        allCaughtUp: queue.allCaughtUp,
        items: await this.withOpensNextWeek(queue.items),
      },
    };
  }

  /** Marks each queue item with "saving a review opens this student's next week", using the real unlock rules. */
  private async withOpensNextWeek<T extends { id: string; assignment: { id: string } }>(items: T[]): Promise<(T & { opensNextWeek: boolean })[]> {
    if (items.length === 0) return [];

    const rows = await this.prisma.submission.findMany({
      where: { id: { in: items.map((item) => item.id) } },
      select: {
        id: true,
        enrollmentId: true,
        enrollment: { select: { status: true, cohort: { select: { courseContent: { select: { id: true, publishedVersion: true } } } } } },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return Promise.all(
      items.map(async (item) => {
        const row = byId.get(item.id);
        const content = row?.enrollment.cohort.courseContent;
        // Reviews only open weeks for a student who is learning now, in a published course.
        if (!row || row.enrollment.status !== EnrollmentStatus.ACTIVE || !content || content.publishedVersion === null) {
          return { ...item, opensNextWeek: false };
        }

        const snapshot = await this.published.get(content.id, content.publishedVersion).catch(() => null);
        const week = snapshot?.weeks.find((candidate) => candidate.assignment?.id === item.assignment.id);
        if (!snapshot || !week) return { ...item, opensNextWeek: false };

        const state = await this.progress.load(this.prisma, row.enrollmentId, snapshot);
        return { ...item, opensNextWeek: wouldOpenNextWeek(snapshot, state, week.id) };
      }),
    );
  }
}
EOF

# ============================================================================
cat > src/instructor/workspace/workspace.controller.ts <<'EOF'
/**
 * workspace.controller.ts
 * ---------------------------------------------------------------------------
 * The instructor workspace. Instructors see only their own cohorts; admins see every current
 * cohort (checked against the database on every request).
 *
 *   GET /api/v1/instructor/dashboard                    numbers, course cards, review queue
 *   GET /api/v1/instructor/students                     the students list (search, filters, paging, counts)
 *   GET /api/v1/instructor/students/export              the same list as a CSV file (10 a minute)
 *   GET /api/v1/instructor/students/:enrollmentId       one student: progress, work, goal, activity
 */
import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthenticatedUser, getRequestContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { StudentsQuery } from './dto/students.query';
import { InstructorDashboardService } from './instructor-dashboard.service';
import { InstructorStudentsService } from './instructor-students.service';

@Roles(Role.INSTRUCTOR, Role.ADMIN)
@Controller('instructor')
export class WorkspaceController {
  constructor(
    private readonly dashboard: InstructorDashboardService,
    private readonly students: InstructorStudentsService,
  ) {}

  @Get('dashboard')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboard.get(user);
  }

  @Get('students')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: StudentsQuery) {
    return this.students.list(user, query);
  }

  // Declared BEFORE ":enrollmentId" so "export" is never mistaken for an id.
  @Get('students/export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: StudentsQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.students.exportCsv(user, query, getRequestContext(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="students-${this.students.fileDate()}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }

  @Get('students/:enrollmentId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('enrollmentId', new ParseUUIDPipe()) enrollmentId: string) {
    return this.students.detail(user, enrollmentId);
  }
}
EOF

# ============================================================================
# Changed file: the grading module now shares its scope and inbox with the instructor workspace
cat > src/grading/grading.module.ts <<'EOF'
/**
 * grading.module.ts
 * ---------------------------------------------------------------------------
 * Reviewing student work: the inbox, one submission's detail, and saving reviews.
 *
 * It relies on the ownership rule registered by CourseContentModule ("course-content.manage")
 * to decide whose submissions an instructor may review, on the learning module for the shared
 * progress rules and for opening submitted files, and on the achievements module to record a
 * review in the student's activity and to award the badges a review can unlock.
 *
 * It shares GradingScopeService ("whose students may this person see?") and InboxService (the
 * waiting-for-review list) with the instructor workspace, so the dashboard's review queue and
 * the grading inbox can never disagree.
 */
import { Module } from '@nestjs/common';

import { AchievementsModule } from '../achievements/achievements.module';
import { AuthModule } from '../auth/auth.module';
import { LearningModule } from '../learning/learning.module';
import { GradingController } from './grading.controller';
import { GradingScopeService } from './grading-scope.service';
import { InboxService } from './inbox.service';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [AuthModule, LearningModule, AchievementsModule],
  controllers: [GradingController],
  providers: [GradingScopeService, InboxService, ReviewsService],
  exports: [GradingScopeService, InboxService],
})
export class GradingModule {}
EOF

echo "Batch 5C files created. Now replace the file shown below the script."