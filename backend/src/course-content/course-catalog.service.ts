/**
 * course-catalog.service.ts
 * ---------------------------------------------------------------------------
 * The admin's overview of every course: its master template and each cohort's
 * copy, with how many lessons there are and whether students can see anything
 * yet. It answers "what is published where, and what is still a draft?" in one
 * page of results, using a fixed number of queries however many courses there are.
 *
 * For every template or cohort copy the catalog says:
 *   status  NOT_PUBLISHED        nothing is live yet (students see nothing)
 *           PUBLISHED            the live version is up to date with the draft
 *           UNPUBLISHED_CHANGES  something is live, but the draft has changes waiting
 *   liveLessons   lessons in the live version (empty if nothing is live)
 *   draftLessons  lessons in the draft right now
 */
import { Injectable } from '@nestjs/common';
import { ContentKind, Prisma } from '@prisma/client';

import { formatCalendarDate } from '../catalog/catalog.util';
import { buildPage, Paginated, toSkipTake } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { CourseCatalogQuery } from './dto/course-catalog.query';

export type ContentStatus = 'NOT_PUBLISHED' | 'PUBLISHED' | 'UNPUBLISHED_CHANGES';

export interface ContentSummary {
  contentId: string;
  status: ContentStatus;
  liveVersion: number | null;
  publishedAt: Date | null;
  liveLessons: number | null;
  draftLessons: number;
}

export interface CatalogCourse {
  id: string;
  title: string;
  status: string;
  track: { id: string; name: string };
  /** The course's master template (null until an admin first opens it). */
  template: ContentSummary | null;
  cohorts: {
    id: string;
    name: string;
    status: string;
    startsOn: string;
    endsOn: string;
    /** This cohort's own copy (null until it is first opened). */
    content: ContentSummary | null;
  }[];
}

@Injectable()
export class CourseCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: CourseCatalogQuery): Promise<Paginated<CatalogCourse>> {
    const where: Prisma.CourseWhereInput = {
      ...(query.trackId ? { trackId: query.trackId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [total, courses] = await Promise.all([
      this.prisma.course.count({ where }),
      this.prisma.course.findMany({
        where,
        orderBy: [{ track: { name: 'asc' } }, { title: 'asc' }, { id: 'asc' }],
        ...toSkipTake(query),
        select: { id: true, title: true, status: true, track: { select: { id: true, name: true } } },
      }),
    ]);
    if (courses.length === 0) return buildPage([], total, query);

    const courseIds = courses.map((course) => course.id);

    // Four more queries for the whole page, no matter how many courses it holds.
    const [cohorts, contents] = await Promise.all([
      this.prisma.cohort.findMany({
        where: { courseId: { in: courseIds } },
        orderBy: [{ startsOn: 'desc' }, { id: 'asc' }],
        select: { id: true, courseId: true, name: true, status: true, startsOn: true, endsOn: true },
      }),
      this.prisma.courseContent.findMany({
        where: { courseId: { in: courseIds } },
        select: {
          id: true,
          kind: true,
          courseId: true,
          cohortId: true,
          publishedVersion: true,
          publishedAt: true,
          draftRevision: true,
          publishedDraftRevision: true,
        },
      }),
    ]);

    const contentIds = contents.map((content) => content.id);
    const [versions, draftLessonCounts] = await Promise.all([
      this.prisma.courseVersion.findMany({
        where: { contentId: { in: contentIds } },
        select: { contentId: true, number: true, lessonCount: true },
      }),
      this.prisma.courseLesson.groupBy({
        by: ['contentId'],
        where: { contentId: { in: contentIds } },
        _count: { _all: true },
      }),
    ]);

    const liveLessons = new Map(versions.map((version) => [`${version.contentId}:${version.number}`, version.lessonCount]));
    const draftLessons = new Map(draftLessonCounts.map((row) => [row.contentId, row._count._all]));

    const summarize = (content: (typeof contents)[number]): ContentSummary => {
      const live = content.publishedVersion;
      return {
        contentId: content.id,
        status:
          live === null
            ? 'NOT_PUBLISHED'
            : content.draftRevision !== content.publishedDraftRevision
              ? 'UNPUBLISHED_CHANGES'
              : 'PUBLISHED',
        liveVersion: live,
        publishedAt: content.publishedAt,
        liveLessons: live === null ? null : (liveLessons.get(`${content.id}:${live}`) ?? 0),
        draftLessons: draftLessons.get(content.id) ?? 0,
      };
    };

    const templateOf = new Map<string, ContentSummary>();
    const copyOf = new Map<string, ContentSummary>();
    for (const content of contents) {
      if (content.kind === ContentKind.TEMPLATE) templateOf.set(content.courseId, summarize(content));
      else if (content.cohortId) copyOf.set(content.cohortId, summarize(content));
    }

    const items = courses.map(
      (course): CatalogCourse => ({
        id: course.id,
        title: course.title,
        status: course.status,
        track: course.track,
        template: templateOf.get(course.id) ?? null,
        cohorts: cohorts
          .filter((cohort) => cohort.courseId === course.id)
          .map((cohort) => ({
            id: cohort.id,
            name: cohort.name,
            status: cohort.status,
            startsOn: formatCalendarDate(cohort.startsOn),
            endsOn: formatCalendarDate(cohort.endsOn),
            content: copyOf.get(cohort.id) ?? null,
          })),
      }),
    );

    return buildPage(items, total, query);
  }
}
