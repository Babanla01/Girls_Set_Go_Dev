/**
 * achievements.service.ts  (the student's side)
 * ---------------------------------------------------------------------------
 * A student's badges and activity feed. They belong to her ENROLLMENT: the one she is learning
 * in now, or - once she has finished - the most recent one she completed. Anyone without an
 * enrollment (pending, declined, never applied) gets the same plain 403 as the course screens.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { NOT_OPEN_MESSAGE } from '../learning/learning.constants';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from './activity.service';
import { BadgesService } from './badges.service';
import type { ActivityQuery } from './dto/activity.query';

@Injectable()
export class AchievementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly badges: BadgesService,
    private readonly activity: ActivityService,
  ) {}

  async myBadges(user: AuthenticatedUser) {
    return this.badges.list(await this.enrollmentIdOf(user));
  }

  async myActivity(user: AuthenticatedUser, query: ActivityQuery) {
    const enrollmentId = await this.enrollmentIdOf(user);
    await this.activity.ensureBackfilled(enrollmentId);
    // Badges earned by past progress should appear in the feed the first time she looks.
    await this.badges.syncQuietly(enrollmentId);
    return this.activity.feed(enrollmentId, query);
  }

  /** Her active enrollment, else the most recently completed one. */
  private async enrollmentIdOf(user: AuthenticatedUser): Promise<string> {
    const enrollment =
      (await this.prisma.enrollment.findFirst({ where: { studentId: user.id, status: EnrollmentStatus.ACTIVE }, select: { id: true } })) ??
      (await this.prisma.enrollment.findFirst({
        where: { studentId: user.id, status: EnrollmentStatus.COMPLETED },
        orderBy: [{ endedAt: 'desc' }, { id: 'asc' }],
        select: { id: true },
      }));
    if (!enrollment) throw new ForbiddenException(NOT_OPEN_MESSAGE);
    return enrollment.id;
  }
}
