/**
 * assignments.service.ts  (the student's side)
 * ---------------------------------------------------------------------------
 * The student's assignments: the list ("All assignments / To do / Submitted / Feedback")
 * and one assignment's detail with her submission.
 *
 *  - Students only see the assignments of the LIVE PUBLISHED version of their own cohort's course.
 *  - An assignment in a LOCKED week shows only its title and why it is locked - never its brief.
 *  - The deadline is worked out from the week's live class (see assignment-rules.ts). The
 *    answer carries exact instants plus the timezone, so the screen can show both
 *    "Fri, Oct 9 at 5:00 PM Central" and the student's own local time.
 *  - The rubric is sent only when the instructor made it visible to students.
 *  - "canSubmit" and the notice come from the SAME rule that decides a submit, so the screen
 *    can never promise something the server will refuse.
 *
 * The four tabs:
 *   All        everything
 *   To do      not submitted yet, or the instructor asked for changes
 *   Submitted  sent and waiting to be looked at
 *   Feedback   reviewed, needs changes, or completed
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { formatCalendarDate } from '../catalog/catalog.util';
import type { SnapshotAssignment, SnapshotWeek } from '../course-content/snapshot';
import { AssignmentContextService } from './assignment-context.service';
import { LATE_MESSAGE, phaseAt, scheduleFor, submitDecision } from './assignment-rules';
import type { LearningContext } from './learning-access.service';
import type { WeekProgress } from './learning-rules';
import { SubmissionsService, SubmissionSummary } from './submissions.service';

export type AssignmentTab = 'all' | 'todo' | 'submitted' | 'feedback';
export const ASSIGNMENT_TABS: readonly AssignmentTab[] = ['all', 'todo', 'submitted', 'feedback'];

type ItemStatus = 'LOCKED' | 'NOT_SUBMITTED' | 'SUBMITTED' | 'REVIEWED' | 'NEEDS_REVISION' | 'COMPLETED';

const TAB_FILTERS: Record<AssignmentTab, (status: ItemStatus) => boolean> = {
  all: () => true,
  todo: (status) => status === 'NOT_SUBMITTED' || status === 'NEEDS_REVISION',
  submitted: (status) => status === 'SUBMITTED',
  feedback: (status) => status === 'REVIEWED' || status === 'NEEDS_REVISION' || status === 'COMPLETED',
};

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly context: AssignmentContextService,
    private readonly submissions: SubmissionsService,
  ) {}

  // -------------------------------------------------------------------- list

  async list(user: AuthenticatedUser, tab: AssignmentTab) {
    if (!ASSIGNMENT_TABS.includes(tab)) throw new BadRequestException(`tab must be one of: ${ASSIGNMENT_TABS.join(', ')}.`);

    const ctx = await this.context.requireReady(user);
    const [{ snapshot, weeks }, submitted] = await Promise.all([this.context.load(ctx), this.submissions.summaries(ctx.enrollmentId)]);
    const now = new Date();

    const items = snapshot.weeks.flatMap((week, index) => {
      if (!week.assignment) return [];
      return [this.summarize(week, week.assignment, weeks[index], ctx, now, submitted.get(week.assignment.id) ?? null)];
    });

    return { tab, assignments: items.filter((item) => TAB_FILTERS[tab](item.status)) };
  }

  // ------------------------------------------------------------------ detail

  async detail(user: AuthenticatedUser, assignmentId: string) {
    const ctx = await this.context.requireReady(user);
    const { snapshot, weeks } = await this.context.load(ctx);

    const index = snapshot.weeks.findIndex((week) => week.assignment?.id === assignmentId);
    const week = snapshot.weeks[index];
    const assignment = week?.assignment;
    if (!week || !assignment) throw new NotFoundException('Assignment not found.');

    const progress = weeks[index];
    const now = new Date();
    const submitted = (await this.submissions.summaries(ctx.enrollmentId)).get(assignmentId) ?? null;
    const summary = this.summarize(week, assignment, progress, ctx, now, submitted);

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
      // Why she cannot send (closed, complete...), or a gentle heads-up when it will be marked Late.
      notice: summary.decision?.reason ?? (summary.decision?.isLate ? LATE_MESSAGE : null),
      readOnly: ctx.readOnly,
      submission: await this.submissions.fullView(ctx.enrollmentId, assignmentId, user.id),
    };
  }

  // ----------------------------------------------------------------- helpers

  private summarize(
    week: SnapshotWeek,
    assignment: SnapshotAssignment,
    progress: WeekProgress,
    ctx: LearningContext,
    now: Date,
    submission: SubmissionSummary | null,
  ) {
    const schedule = scheduleFor(week.classSession ? new Date(week.classSession.startsAt) : null);
    const phase = phaseAt(schedule, now);
    const decision =
      progress.open && !ctx.readOnly
        ? submitDecision({
            phase,
            status: submission?.status ?? null,
            revisionOpenUntil: submission?.revisionOpenUntil ?? null,
            now,
            versionCount: submission?.versionCount ?? 0,
          })
        : null;
    const status: ItemStatus = !progress.open ? 'LOCKED' : (submission?.status ?? 'NOT_SUBMITTED');

    return {
      id: assignment.id,
      title: assignment.title,
      expectedMinutes: assignment.expectedMinutes,
      week: { id: week.id, position: progress.position, title: week.title },
      status,
      phase,
      schedule: {
        timezone: schedule.timezone,
        classStartsAt: schedule.classStartsAt,
        dueAt: schedule.dueAt,
        closesAt: schedule.closesAt,
        phase,
      },
      canSubmit: decision?.allowed ?? false,
      decision,
      submission: submission
        ? {
            reference: submission.reference,
            version: submission.version,
            isLate: submission.isLate,
            submittedAt: submission.submittedAt,
            revisionOpenUntil: submission.revisionOpenUntil,
          }
        : null,
      cohortStartsOn: formatCalendarDate(ctx.cohort.startsOn),
    };
  }
}