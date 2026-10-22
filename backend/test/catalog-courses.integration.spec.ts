/**
 * catalog-courses.integration.spec.ts
 * ---------------------------------------------------------------------------
 * Admin: courses - against the REAL app, PostgreSQL and Redis.
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { CourseStatus, Role } from '@prisma/client';
import request from 'supertest';

import { makeCohort, makeCourse, makeTrack } from './helpers/catalog-helpers';
import { createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const COURSES = '/api/v1/admin/courses';
const SOME_ID = '11111111-1111-4111-8111-111111111111';

describe('Admin: courses (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;
  let adminId: string;
  let trackId: string;

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    adminId = (await kit.createUser({ email: 'admin@example.org', fullName: 'Ada Admin', role: Role.ADMIN })).id;
    admin = await kit.loginAgent('admin@example.org', 'admin');
    trackId = await makeTrack(admin, 'AI & Robotics');
  });

  const auditActions = async (where = {}) =>
    (await kit.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } })).map((row) => row.action);

  // ---------------------------------------------------- who may use these routes

  it('refuses signed-out visitors (401) and students/instructors (403) on every course route', async () => {
    await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
    await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
    const student = await kit.loginAgent('student@example.org', 'student');
    const teacher = await kit.loginAgent('teacher@example.org', 'instructor');

    const routes: Array<['get' | 'post' | 'patch', string]> = [
      ['post', COURSES],
      ['get', COURSES],
      ['get', `${COURSES}/${SOME_ID}`],
      ['patch', `${COURSES}/${SOME_ID}`],
      ['post', `${COURSES}/${SOME_ID}/publish`],
      ['post', `${COURSES}/${SOME_ID}/unpublish`],
      ['post', `${COURSES}/${SOME_ID}/archive`],
      ['post', `${COURSES}/${SOME_ID}/restore`],
    ];
    for (const [method, url] of routes) {
      await request(kit.server())[method](url).send({}).expect(401);
      await student[method](url).send({}).expect(403);
      await teacher[method](url).send({}).expect(403);
    }
    expect(await kit.prisma.course.count()).toBe(0);
  });

  // ------------------------------------------------------------------ create

  describe('create', () => {
    it('creates a DRAFT course inside the track, with an audit entry', async () => {
      const res = await admin.post(COURSES).send({ trackId, title: '  Intro   to AI ', description: 'Start here.' }).expect(201);

      expect(res.body.course).toMatchObject({
        title: 'Intro to AI',
        description: 'Start here.',
        status: 'DRAFT',
        track: { id: trackId, name: 'AI & Robotics' },
        activeCohortCount: 0,
      });
      const row = await kit.prisma.course.findFirstOrThrow();
      expect(row).toMatchObject({ titleKey: 'intro to ai', createdById: adminId, trackId });

      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'course.created' } });
      expect(audit).toMatchObject({ actorId: adminId, entityId: row.id, metadata: { title: 'Intro to AI', trackId } });
    });

    it('refuses a duplicate title in the same track (any capitals), but allows it in another track', async () => {
      await makeCourse(admin, trackId, 'Intro to AI');
      const res = await admin.post(COURSES).send({ trackId, title: 'INTRO  to ai' }).expect(409);
      expect(res.body.message).toContain('already exists');

      const otherTrack = await makeTrack(admin, 'UI/UX Design');
      await admin.post(COURSES).send({ trackId: otherTrack, title: 'Intro to AI' }).expect(201);
      expect(await kit.prisma.course.count()).toBe(2);
    });

    it('lets exactly one of two simultaneous creations win', async () => {
      const [a, b] = await Promise.all([
        admin.post(COURSES).send({ trackId, title: 'Race Course' }),
        admin.post(COURSES).send({ trackId, title: 'race COURSE' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await kit.prisma.course.count()).toBe(1);
    });

    it('answers 404 for an unknown track and 400 for bad input, and cannot set the status', async () => {
      await admin.post(COURSES).send({ trackId: SOME_ID, title: 'Orphan Course' }).expect(404);

      for (const body of [
        {},
        { title: 'No Track' },
        { trackId: 'not-a-uuid', title: 'Bad Track' },
        { trackId, title: 'A' },
        { trackId, title: 'Valid Title', status: 'PUBLISHED' },
        { trackId, title: 'Valid Title', description: 'x'.repeat(5001) },
      ]) {
        await admin.post(COURSES).send(body).expect(400);
      }
      expect(await kit.prisma.course.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------- list

  describe('list and detail', () => {
    it('filters by track, status and search, sorts, and pages', async () => {
      const otherTrack = await makeTrack(admin, 'UI/UX Design');
      await makeCourse(admin, trackId, 'Zeta Course');
      const alpha = await makeCourse(admin, trackId, 'Alpha Course');
      await makeCourse(admin, otherTrack, 'Design Basics');
      await admin.post(`${COURSES}/${alpha}/publish`).expect(200);

      expect((await admin.get(COURSES).expect(200)).body.total).toBe(3);
      expect((await admin.get(`${COURSES}?trackId=${trackId}`).expect(200)).body.items.map((c: { title: string }) => c.title)).toEqual(['Alpha Course', 'Zeta Course']);
      expect((await admin.get(`${COURSES}?status=PUBLISHED`).expect(200)).body.items.map((c: { title: string }) => c.title)).toEqual(['Alpha Course']);
      expect((await admin.get(`${COURSES}?search=design`).expect(200)).body.total).toBe(1);
      expect((await admin.get(`${COURSES}?sortBy=title&sortDir=desc&pageSize=1`).expect(200)).body.items[0].title).toBe('Zeta Course');
    });

    it('rejects bad list parameters', async () => {
      for (const query of ['trackId=nope', 'status=NOPE', 'pageSize=101', 'sortBy=titleKey', 'foo=bar']) {
        await admin.get(`${COURSES}?${query}`).expect(400);
      }
    });

    it('shows one course, 404 for unknown and 400 for malformed ids', async () => {
      const id = await makeCourse(admin, trackId);
      expect((await admin.get(`${COURSES}/${id}`).expect(200)).body.course.id).toBe(id);
      await admin.get(`${COURSES}/${SOME_ID}`).expect(404);
      await admin.get(`${COURSES}/not-a-uuid`).expect(400);
    });
  });

  // ------------------------------------------------------------------ update

  describe('update', () => {
    it('changes the title and description, and audits what changed', async () => {
      const id = await makeCourse(admin, trackId, 'Old Title');
      await admin.patch(`${COURSES}/${id}`).send({ title: 'New  Title', description: 'Fresh words' }).expect(200);

      const row = await kit.prisma.course.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ title: 'New Title', titleKey: 'new title', description: 'Fresh words' });
      expect((await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'course.updated' } })).metadata).toEqual({ changed: ['title', 'description'] });
    });

    it('cannot move a course to another track, set its status, or take a duplicate title', async () => {
      const otherTrack = await makeTrack(admin, 'UI/UX Design');
      await makeCourse(admin, trackId, 'Taken Title');
      const id = await makeCourse(admin, trackId, 'My Course');

      await admin.patch(`${COURSES}/${id}`).send({ trackId: otherTrack }).expect(400);
      await admin.patch(`${COURSES}/${id}`).send({ status: 'PUBLISHED' }).expect(400);
      await admin.patch(`${COURSES}/${id}`).send({ title: 'taken TITLE' }).expect(409);
      await admin.patch(`${COURSES}/${id}`).send({}).expect(400);
      await admin.patch(`${COURSES}/${SOME_ID}`).send({ title: 'Ghost Course' }).expect(404);

      expect(await kit.prisma.course.findUniqueOrThrow({ where: { id } })).toMatchObject({ trackId, title: 'My Course', status: 'DRAFT' });
    });

    it('does nothing, and records nothing, when the values are unchanged', async () => {
      const id = await makeCourse(admin, trackId, 'Same Title');
      await admin.patch(`${COURSES}/${id}`).send({ title: 'Same Title' }).expect(200);
      expect(await auditActions({ action: 'course.updated' })).toEqual([]);
    });
  });

  // ------------------------------------------------------ publish / unpublish

  describe('publish and unpublish', () => {
    it('moves a course between draft and published, auditing each step', async () => {
      const id = await makeCourse(admin, trackId);

      expect((await admin.post(`${COURSES}/${id}/publish`).expect(200)).body.course.status).toBe('PUBLISHED');
      expect((await admin.post(`${COURSES}/${id}/unpublish`).expect(200)).body.course.status).toBe('DRAFT');
      expect(await auditActions({ action: { in: ['course.published', 'course.unpublished'] } })).toEqual(['course.published', 'course.unpublished']);
    });

    it('refuses publishing a published course, or unpublishing a draft', async () => {
      const id = await makeCourse(admin, trackId);
      await admin.post(`${COURSES}/${id}/unpublish`).expect(409);
      await admin.post(`${COURSES}/${id}/publish`).expect(200);
      await admin.post(`${COURSES}/${id}/publish`).expect(409);
    });

    it('refuses publishing an archived course', async () => {
      const id = await makeCourse(admin, trackId);
      await admin.post(`${COURSES}/${id}/archive`).expect(200);
      await admin.post(`${COURSES}/${id}/publish`).expect(409);
    });

    it('refuses to unpublish while the course has active cohorts, then allows it once they are archived', async () => {
      const id = await makeCourse(admin, trackId);
      await admin.post(`${COURSES}/${id}/publish`).expect(200);
      const cohortId = await makeCohort(admin, id);

      const blocked = await admin.post(`${COURSES}/${id}/unpublish`).expect(409);
      expect(blocked.body.message).toContain('1 active cohort');
      expect((await kit.prisma.course.findUniqueOrThrow({ where: { id } })).status).toBe(CourseStatus.PUBLISHED);

      await admin.post(`/api/v1/admin/cohorts/${cohortId}/archive`).expect(200);
      await admin.post(`${COURSES}/${id}/unpublish`).expect(200);
    });
  });

  // -------------------------------------------------------- archive / restore

  describe('archive and restore', () => {
    it('refuses to archive while the course has active cohorts, and says how many', async () => {
      const id = await makeCourse(admin, trackId);
      await makeCohort(admin, id, { name: 'Cohort 1' });
      await makeCohort(admin, id, { name: 'Cohort 2' });

      const blocked = await admin.post(`${COURSES}/${id}/archive`).expect(409);
      expect(blocked.body.message).toContain('2 active cohorts');
    });

    it('archives once cohorts are archived; refuses to archive twice; restores as a DRAFT', async () => {
      const id = await makeCourse(admin, trackId);
      await admin.post(`${COURSES}/${id}/publish`).expect(200);
      const cohortId = await makeCohort(admin, id);
      await admin.post(`/api/v1/admin/cohorts/${cohortId}/archive`).expect(200);

      expect((await admin.post(`${COURSES}/${id}/archive`).expect(200)).body.course.status).toBe('ARCHIVED');
      await admin.post(`${COURSES}/${id}/archive`).expect(409);

      const restored = await admin.post(`${COURSES}/${id}/restore`).expect(200);
      expect(restored.body.course.status).toBe('DRAFT'); // must be published again on purpose
      await admin.post(`${COURSES}/${id}/restore`).expect(409);
      expect(await auditActions({ action: { in: ['course.archived', 'course.restored'] } })).toEqual(['course.archived', 'course.restored']);
    });

    it('refuses to restore a course while its track is archived', async () => {
      const id = await makeCourse(admin, trackId);
      await admin.post(`${COURSES}/${id}/archive`).expect(200);
      await admin.post(`/api/v1/admin/tracks/${trackId}/archive`).expect(200);

      const blocked = await admin.post(`${COURSES}/${id}/restore`).expect(409);
      expect(blocked.body.message).toContain('Restore the track first');

      await admin.post(`/api/v1/admin/tracks/${trackId}/restore`).expect(200);
      await admin.post(`${COURSES}/${id}/restore`).expect(200);
    });

    it('never ends up with an archived course holding an active cohort, even when both happen at the same instant', async () => {
      for (let round = 0; round < 6; round++) {
        const id = await makeCourse(admin, trackId, `Race Course ${round}`);

        await Promise.all([
          admin.post(`${COURSES}/${id}/archive`),
          admin.post('/api/v1/admin/cohorts').send({ courseId: id, name: `Race Cohort ${round}`, startsOn: '2030-01-01', endsOn: '2030-06-01' }),
        ]);

        const course = await kit.prisma.course.findUniqueOrThrow({ where: { id } });
        const activeCohorts = await kit.prisma.cohort.count({ where: { courseId: id, status: 'ACTIVE' } });
        expect(course.status === CourseStatus.ARCHIVED && activeCohorts > 0).toBe(false);
      }
    });
  });
});