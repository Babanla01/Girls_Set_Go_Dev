/**
 * assignments.service.ts  (the student's side)
 * ---------------------------------------------------------------------------
 * The student's assignments: the list ("All assignments / To do / Submitted / Feedback")
 * and one assignment's detail.
 *
 *  - Students only see the assignments of the LIVE PUBLISHED version of their own cohort's course.
 *  - An assignment in a LOCKED week shows only its title and why it is locked - never its brief.
 *  - The deadline is worked out from the week's live class (see assignment-rules.ts). The
 *    answer carries exact instants plus the timezone, so the screen can show both
 *    "Fri, Oct 9 at 5:00 PM Central" and the student's own local time.
 *  - The rubric is sent only when the instructor made it visible to students.
 *
 * Submitting work, receipts and feedback arrive in the next parts of this batch; until then
 * every unlocked assignment is "Not submitted".
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { formatCalendarDate } from '../catalog/catalog.util';
import { PrismaService } from '../prisma/prisma.service';
import { CLOSED_MESSAGE, LATE_MESSAGE, phaseAt, scheduleFor } from './assignment-rules';
import { LearningAccessService, LearningContext } from './learning-access.service';
import { evaluateWeeks, WeekProgress } from './learning-rules';
import { cohortNotStartedMessage, NOT_OPEN_MESSAGE, NOT_READY_MESSAGE } from './learning.constants';
import { PublishedCourseService } from './published-course.service';
import type { Snapshot, SnapshotAssignment, SnapshotWeek } from '../course-content/snapshot';

export type AssignmentTab = 'all' | 'todo' | 'submitted' | 'feedback';
export const ASSIGNMENT_TABS: readonly AssignmentTab[] = ['all', 'todo', 'submitted', 'feedback'];

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly published: PublishedCourseService,
  ) {}

  // -------------------------------------------------------------------- list

  async list(user: AuthenticatedUser, tab: AssignmentTab) {
    if (!ASSIGNMENT_TABS.includes(tab)) throw new BadRequestException(`tab must be one of: ${ASSIGNMENT_TABS.join(', ')}.`);

    const context = await this.requireReady(user);
    const { snapshot, weeks } = await this.load(context);
    const now = new Date();

    const items = snapshot.weeks.flatMap((week, index) => {
      if (!week.assignment) return [];
      return [this.summarize(week, week.assignment, weeks[index], context, now)];
    });

    // Nothing is submitted or reviewed yet, so only "all" and "to do" can have rows.
    const visible = tab === 'all' ? items : tab === 'todo' ? items.filter((item) => item.status === 'NOT_SUBMITTED') : [];
    return { tab, assignments: visible };
  }

  // ------------------------------------------------------------------ detail

  async detail(user: AuthenticatedUser, assignmentId: string) {
    const context = await this.requireReady(user);
    const { snapshot, weeks } = await this.load(context);

    const index = snapshot.weeks.findIndex((week) => week.assignment?.id === assignmentId);
    const week = snapshot.weeks[index];
    const assignment = week?.assignment;
    if (!week || !assignment) throw new NotFoundException('Assignment not found.');

    const progress = weeks[index];
    const now = new Date();
    const summary = this.summarize(week, assignment, progress, context, now);

    // A locked week: the title and the reason only.
    if (!progress.open) {
      return {
        locked: true as const,
        assignment: { id: assignment.id, title: assignment.title },
        week: summary.week,
        lockedReason: progress.lockedReason,
      };
    }

    return {
      locked: false as const,
      assignment: {
        id: assignment.id,
        title: assignment.title,
        brief: assignment.brief,
        includes: assignment.includes,
        successEvidence: assignment.successEvidence,
        expectedMinutes: assignment.expectedMinutes,
        allowedFileTypes: assignment.allowedFileTypes,
        // Only when the instructor chose to show it.
        rubric: assignment.rubricVisible ? assignment.rubric : null,
      },
      week: summary.week,
      status: summary.status,
      schedule: summary.schedule,
      canSubmit: summary.canSubmit,
      notice: summary.phase === 'LATE' ? LATE_MESSAGE : summary.phase === 'CLOSED' ? CLOSED_MESSAGE : null,
      readOnly: context.readOnly,
    };
  }

  // ----------------------------------------------------------------- helpers

  private summarize(week: SnapshotWeek, assignment: SnapshotAssignment, progress: WeekProgress, context: LearningContext, now: Date) {
    const schedule = scheduleFor(week.classSession ? new Date(week.classSession.startsAt) : null);
    const phase = phaseAt(schedule, now);
    const open = progress.open;

    return {
      id: assignment.id,
      title: assignment.title,
      expectedMinutes: assignment.expectedMinutes,
      week: { id: week.id, position: progress.position, title: week.title },
      status: open ? ('NOT_SUBMITTED' as const) : ('LOCKED' as const),
      phase,
      schedule: {
        timezone: schedule.timezone,
        classStartsAt: schedule.classStartsAt,
        dueAt: schedule.dueAt,
        closesAt: schedule.closesAt,
        phase,
      },
      canSubmit: open && !context.readOnly && phase !== 'CLOSED',
      cohortStartsOn: formatCalendarDate(context.cohort.startsOn),
    };
  }

  private async load(context: LearningContext): Promise<{ snapshot: Snapshot; weeks: WeekProgress[] }> {
    const snapshot = await this.published.get(context.contentId, context.version);
    const [done, opened] = await Promise.all([
      this.prisma.lessonProgress.findMany({
        where: { enrollmentId: context.enrollmentId, completedAt: { not: null } },
        select: { lessonId: true },
      }),
      this.prisma.weekUnlock.findMany({ where: { enrollmentId: context.enrollmentId }, select: { weekId: true } }),
    ]);
    const weeks = evaluateWeeks(snapshot, {
      completed: new Set(done.map((row) => row.lessonId)),
      unlocked: new Set(opened.map((row) => row.weekId)),
      allOpen: context.readOnly,
    });
    return { snapshot, weeks };
  }

  private async requireReady(user: AuthenticatedUser): Promise<LearningContext> {
    const access = await this.access.resolve(user);
    switch (access.kind) {
      case 'READY':
        return access.context;
      case 'NOT_STARTED':
        throw new ForbiddenException(cohortNotStartedMessage(formatCalendarDate(access.cohort.startsOn)));
      case 'NOT_READY':
        throw new ConflictException(NOT_READY_MESSAGE);
      default:
        throw new ForbiddenException(NOT_OPEN_MESSAGE);
    }
  }
}
