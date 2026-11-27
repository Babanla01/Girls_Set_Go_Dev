/**
 * audience.service.ts
 * ---------------------------------------------------------------------------
 * Who an announcement is for - and who is allowed to write to whom.
 *
 *   ALL_COHORTS   every learner in a cohort that is PLANNED or ACTIVE (a closed cohort is over)
 *   TRACK         the learners of every running cohort of that track
 *   COHORT        the learners of one running cohort
 *
 * "Learner" always means a student with an ACTIVE enrollment and an ACTIVE account.
 *
 * Writing rules:
 *   - an ADMIN may write to ALL_COHORTS (unless the setting announcements.admin_scope
 *     says TRACK_OR_COHORT), to a TRACK, or to a COHORT
 *   - an INSTRUCTOR may write only to a COHORT she teaches
 * This service only READS the learning portal's tables (tracks, courses, cohorts,
 * enrollments, cohort_instructors); it never changes them.
 */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AccountStatus, AnnAudienceType, CohortStatus, EnrollmentStatus, Prisma, Role, TrackStatus } from '@prisma/client';

import { SettingsService } from '../../platform/settings/settings.service';
import { PrismaService } from '../../prisma/prisma.service';

/** A cohort that has not finished: students in it can still read announcements. */
export const RUNNING_COHORT_STATUSES: CohortStatus[] = [CohortStatus.PLANNED, CohortStatus.ACTIVE];

export interface AudienceInput {
  audienceType: AnnAudienceType;
  trackId: string | null;
  cohortId: string | null;
}

export interface StudentScope {
  cohortIds: string[];
  trackIds: string[];
  /** For the heading of the student's page: "Updates for UI/UX Design · Cohort 01". */
  groups: { courseTitle: string; cohortName: string }[];
}

@Injectable()
export class AudienceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------- choosing

  /** What the compose form may offer THIS person. */
  async options(user: { id: string; role: Role }) {
    const adminScope = await this.settings.getValue<'ANY' | 'TRACK_OR_COHORT'>('announcements.admin_scope');

    const cohortWhere: Prisma.CohortWhereInput = {
      status: { in: RUNNING_COHORT_STATUSES },
      ...(user.role === Role.INSTRUCTOR ? { instructors: { some: { instructorId: user.id } } } : {}),
    };
    const [tracks, cohorts] = await Promise.all([
      user.role === Role.ADMIN
        ? this.prisma.track.findMany({ where: { status: TrackStatus.ACTIVE }, orderBy: { name: 'asc' }, select: { id: true, name: true } })
        : Promise.resolve([]),
      this.prisma.cohort.findMany({
        where: cohortWhere,
        orderBy: [{ startsOn: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, status: true, course: { select: { title: true, track: { select: { name: true } } } } },
      }),
    ]);

    return {
      allowAllCohorts: user.role === Role.ADMIN && adminScope === 'ANY',
      tracks,
      cohorts: cohorts.map((cohort) => ({
        id: cohort.id,
        name: cohort.name,
        status: cohort.status,
        courseTitle: cohort.course.title,
        trackName: cohort.course.track.name,
        label: `${cohort.course.title} · ${cohort.name}`,
      })),
    };
  }

  /**
   * Checks that this audience is shape-correct and that the WRITER may write to it.
   * `writer` is the author (for an instructor: she must still teach the cohort).
   */
  async assertAllowed(writer: { id: string; role: Role }, audience: AudienceInput): Promise<void> {
    const { audienceType, trackId, cohortId } = audience;

    if (audienceType === AnnAudienceType.ALL_COHORTS && (trackId || cohortId)) throw new BadRequestException('"All cohorts" has no track or cohort.');
    if (audienceType === AnnAudienceType.TRACK && (!trackId || cohortId)) throw new BadRequestException('Choose one track.');
    if (audienceType === AnnAudienceType.COHORT && (!cohortId || trackId)) throw new BadRequestException('Choose one cohort.');

    if (writer.role === Role.INSTRUCTOR && audienceType !== AnnAudienceType.COHORT) {
      throw new ForbiddenException('Instructors can only write to a cohort they teach.');
    }

    if (audienceType === AnnAudienceType.ALL_COHORTS) {
      const scope = await this.settings.getValue<'ANY' | 'TRACK_OR_COHORT'>('announcements.admin_scope');
      if (scope !== 'ANY') throw new ForbiddenException('Announcements to all cohorts are switched off. Choose a track or a cohort.');
    }

    if (audienceType === AnnAudienceType.TRACK) {
      const track = await this.prisma.track.findUnique({ where: { id: trackId! }, select: { status: true } });
      if (!track) throw new BadRequestException('That track does not exist.');
      if (track.status !== TrackStatus.ACTIVE) throw new BadRequestException('That track is archived.');
    }

    if (audienceType === AnnAudienceType.COHORT) {
      const cohort = await this.prisma.cohort.findUnique({ where: { id: cohortId! }, select: { status: true } });
      if (!cohort) throw new BadRequestException('That cohort does not exist.');
      if (!RUNNING_COHORT_STATUSES.includes(cohort.status)) throw new BadRequestException('That cohort has finished, so it cannot receive announcements.');

      if (writer.role === Role.INSTRUCTOR) {
        const teaches = await this.prisma.cohortInstructor.count({ where: { cohortId: cohortId!, instructorId: writer.id } });
        if (teaches === 0) throw new ForbiddenException('You can only write to a cohort you teach.');
      }
    }
  }

  // ---------------------------------------------------------------- resolving

  /** The students this audience reaches right now. */
  async recipientIds(audience: AudienceInput): Promise<string[]> {
    const where: Prisma.EnrollmentWhereInput = {
      status: EnrollmentStatus.ACTIVE,
      student: { status: AccountStatus.ACTIVE },
      cohort: {
        status: { in: RUNNING_COHORT_STATUSES },
        ...(audience.audienceType === AnnAudienceType.COHORT ? { id: audience.cohortId! } : {}),
        ...(audience.audienceType === AnnAudienceType.TRACK ? { course: { trackId: audience.trackId! } } : {}),
      },
    };
    const rows = await this.prisma.enrollment.findMany({ where, distinct: ['studentId'], select: { studentId: true } });
    return rows.map((row) => row.studentId);
  }

  /** The cohorts and tracks a student currently belongs to (what she may read). */
  async studentScope(studentId: string): Promise<StudentScope> {
    const rows = await this.prisma.enrollment.findMany({
      where: { studentId, status: EnrollmentStatus.ACTIVE, cohort: { status: { in: RUNNING_COHORT_STATUSES } } },
      orderBy: { enrolledAt: 'desc' },
      select: { cohortId: true, cohort: { select: { name: true, course: { select: { title: true, trackId: true } } } } },
    });
    return {
      cohortIds: rows.map((row) => row.cohortId),
      trackIds: [...new Set(rows.map((row) => row.cohort.course.trackId))],
      groups: rows.map((row) => ({ courseTitle: row.cohort.course.title, cohortName: row.cohort.name })),
    };
  }

  /** The cohorts an instructor teaches (any status). */
  async cohortIdsTaughtBy(instructorId: string): Promise<string[]> {
    const rows = await this.prisma.cohortInstructor.findMany({ where: { instructorId }, select: { cohortId: true } });
    return rows.map((row) => row.cohortId);
  }

  // ------------------------------------------------------------------ labels

  /** A readable name for each audience, e.g. "All active cohorts", "AI & Robotics track", "UI/UX Design · Cohort 01". */
  async labels(audiences: AudienceInput[]): Promise<(a: AudienceInput) => string> {
    const trackIds = [...new Set(audiences.map((a) => a.trackId).filter((id): id is string => id !== null))];
    const cohortIds = [...new Set(audiences.map((a) => a.cohortId).filter((id): id is string => id !== null))];

    const [tracks, cohorts] = await Promise.all([
      trackIds.length ? this.prisma.track.findMany({ where: { id: { in: trackIds } }, select: { id: true, name: true } }) : [],
      cohortIds.length
        ? this.prisma.cohort.findMany({ where: { id: { in: cohortIds } }, select: { id: true, name: true, course: { select: { title: true } } } })
        : [],
    ]);
    const trackName = new Map(tracks.map((track) => [track.id, track.name]));
    const cohortName = new Map(cohorts.map((cohort) => [cohort.id, `${cohort.course.title} · ${cohort.name}`]));

    return (audience) => {
      if (audience.audienceType === AnnAudienceType.ALL_COHORTS) return 'All active cohorts';
      if (audience.audienceType === AnnAudienceType.TRACK) return `${trackName.get(audience.trackId ?? '') ?? 'A track'} track`;
      return cohortName.get(audience.cohortId ?? '') ?? 'A cohort';
    };
  }
}