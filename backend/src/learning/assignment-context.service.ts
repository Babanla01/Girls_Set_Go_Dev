/**
 * assignment-context.service.ts
 * ---------------------------------------------------------------------------
 * What every student assignment action needs first:
 *   requireReady()  which course she may open right now (or the plain-English reason she cannot);
 *   load()          the live published course and which weeks are open for her.
 * Shared by the assignment screens and by submitting, so the rules are written once.
 */
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { formatCalendarDate } from '../catalog/catalog.util';
import type { Snapshot } from '../course-content/snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { LearningAccessService, LearningContext } from './learning-access.service';
import { evaluateWeeks, WeekProgress } from './learning-rules';
import { cohortNotStartedMessage, NOT_OPEN_MESSAGE, NOT_READY_MESSAGE } from './learning.constants';
import { PublishedCourseService } from './published-course.service';

@Injectable()
export class AssignmentContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly published: PublishedCourseService,
  ) {}

  async requireReady(user: AuthenticatedUser): Promise<LearningContext> {
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

  async load(context: LearningContext): Promise<{ snapshot: Snapshot; weeks: WeekProgress[] }> {
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
}
