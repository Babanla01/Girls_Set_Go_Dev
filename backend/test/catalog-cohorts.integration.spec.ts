/**
 * catalog-cohorts.integration.spec.ts
 * ---------------------------------------------------------------------------
 * Admin: cohorts and teaching assignments - against the REAL app, PostgreSQL
 * and Redis.
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { AccountStatus, CohortStatus, Role } from '@prisma/client';
import request from 'supertest';

import { dayOffset, makeCohort, makeCourse, makeTrack } from './helpers/catalog-helpers';
import { createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const COHORTS = '/api/v1/admin/cohorts';
const SOME_ID = '11111111-1111-4111-8111-111111111111';

describe('Admin: cohorts (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;
  let adminId: string;
  let trackId: string;
  let courseId: string;

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
    courseId = await makeCourse(admin, trackId, 'Intro to AI');
  });

  const auditActions = async (where = {}) =>
    (await kit.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } })).map((row) => row.action);

  const teacher = (email = 'teacher@example.org', fullName = 'Tina Teacher') =>
    kit.createUser({ email, fullName, role: Role.INSTRUCTOR, status: AccountStatus.ACTIVE });

  // ---------------------------------------------------- who may use these routes

  it('refuses signed-out visitors (401) and students/instructors (403) on every cohort route', async () => {
    await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
    await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
    const student = await kit.loginAgent('student@example.org', 'student');
    const instructor = await kit.loginAgent('teacher@example.org', 'instructor');

    const routes: Array<['get' | 'post' | 'patch' | 'delete', string]> = [
      ['post', COHORTS],
      ['get', COHORTS],
      ['get', `${COHORTS}/${SOME_ID}`],
      ['patch', `${COHORTS}/${SOME_ID}`],
      ['post', `${COHORTS}/${SOME_ID}/archive`],
      ['post', `${COHORTS}/${SOME_ID}/restore`],
      ['post', `${COHORTS}/${SOME_ID}/instructors`],
      ['delete', `${COHORTS}/${SOME_ID}/instructors/${SOME_ID}`],
    ];
    for (const [method, url] of routes) {
      await request(kit.server())[method](url).send({}).expect(401);
      await student[method](url).send({}).expect(403);
      await instructor[method](url).send({}).expect(403);
    }
    expect(await kit.prisma.cohort.count()).toBe(0);
  });

  // ------------------------------------------------------------------ create

  describe('create', () => {
    it('creates an active cohort with dates, capacity, the right course and track, and an audit entry', async () => {
      const res = await admin
        .post(COHORTS)
        .send({ courseId, name: '  Cohort   One ', startsOn: '2030-11-03', endsOn: '2031-02-20', capacity: 30 })
        .expect(201);

      expect(res.body.cohort).toMatchObject({
        name: 'Cohort One',
        startsOn: '2030-11-03',
        endsOn: '2031-02-20',
        capacity: 30,
        status: 'ACTIVE',
        phase: 'upcoming',
        course: { id: courseId, title: 'Intro to AI' },
        track: { id: trackId, name: 'AI & Robotics' }, // the track comes from the course
        instructorCount: 0,
      });

      const row = await kit.prisma.cohort.findFirstOrThrow();
      expect(row).toMatchObject({ nameKey: 'cohort one', createdById: adminId });
      expect(row.startsOn.toISOString()).toBe('2030-11-03T00:00:00.000Z'); // a calendar date, no drift

      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'cohort.created' } });
      expect(audit).toMatchObject({ actorId: adminId, entityId: row.id });
      expect(audit.metadata).toMatchObject({ courseId, startsOn: '2030-11-03', endsOn: '2031-02-20' });
    });

    it('allows no capacity (unlimited) and a one-day cohort', async () => {
      const res = await admin.post(COHORTS).send({ courseId, name: 'One Day', startsOn: '2030-05-05', endsOn: '2030-05-05' }).expect(201);
      expect(res.body.cohort.capacity).toBeNull();
    });

    it('works out upcoming, running and ended from today (first and last day count as running)', async () => {
      const cases: Array<[string, string, string, string]> = [
        ['Upcoming', dayOffset(1), dayOffset(30), 'upcoming'],
        ['Starts today', dayOffset(0), dayOffset(30), 'running'],
        ['Mid-way', dayOffset(-10), dayOffset(10), 'running'],
        ['Ends today', dayOffset(-30), dayOffset(0), 'running'],
        ['Finished', dayOffset(-30), dayOffset(-1), 'ended'],
      ];
      for (const [name, startsOn, endsOn, phase] of cases) {
        const res = await admin.post(COHORTS).send({ courseId, name, startsOn, endsOn }).expect(201);
        expect([name, res.body.cohort.phase]).toEqual([name, phase]);
      }
    });

    it('rejects an end date before the start date (and accepts the same day)', async () => {
      const res = await admin.post(COHORTS).send({ courseId, name: 'Backwards', startsOn: '2030-05-05', endsOn: '2030-05-04' }).expect(400);
      expect(res.body.message).toContain('end date cannot be before');
      expect(await kit.prisma.cohort.count()).toBe(0);
    });

    it('rejects impossible or badly written dates, bad capacities, unknown fields and bad ids', async () => {
      const good = { courseId, name: 'Valid Name', startsOn: '2030-01-01', endsOn: '2030-06-01' };
      for (const bad of [
        { startsOn: '2030-02-30' },
        { startsOn: '2030-1-1' },
        { startsOn: '2030-01-01T10:00:00Z' },
        { endsOn: 'next year' },
        { capacity: 0 },
        { capacity: 10_001 },
        { capacity: 1.5 },
        { capacity: 'many' },
        { name: 'A' },
        { status: 'ARCHIVED' },
        { courseId: 'not-a-uuid' },
      ]) {
        await admin.post(COHORTS).send({ ...good, ...bad }).expect(400);
      }
      await admin.post(COHORTS).send({ name: 'No Course', startsOn: '2030-01-01', endsOn: '2030-06-01' }).expect(400);
      await admin.post(COHORTS).send({ ...good, courseId: SOME_ID }).expect(404);
      expect(await kit.prisma.cohort.count()).toBe(0);
    });

    it('refuses a duplicate name in the same course (any capitals), but allows it in another course', async () => {
      await makeCohort(admin, courseId, { name: 'Cohort 1' });
      const res = await admin.post(COHORTS).send({ courseId, name: 'COHORT  1', startsOn: '2030-01-01', endsOn: '2030-06-01' }).expect(409);
      expect(res.body.message).toContain('already exists');

      const otherCourse = await makeCourse(admin, trackId, 'Another Course');
      await makeCohort(admin, otherCourse, { name: 'Cohort 1' });
      expect(await kit.prisma.cohort.count()).toBe(2);
    });

    it('lets exactly one of two simultaneous creations win', async () => {
      const body = { courseId, startsOn: '2030-01-01', endsOn: '2030-06-01' };
      const [a, b] = await Promise.all([admin.post(COHORTS).send({ ...body, name: 'Race' }), admin.post(COHORTS).send({ ...body, name: 'RACE' })]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
    });

    it('refuses to add a cohort to an archived course', async () => {
      await admin.post(`/api/v1/admin/courses/${courseId}/archive`).expect(200);
      const res = await admin.post(COHORTS).send({ courseId, name: 'Late', startsOn: '2030-01-01', endsOn: '2030-06-01' }).expect(409);
      expect(res.body.message).toContain('archived course');
    });
  });

  // -------------------------------------------------------------------- list

  describe('list and detail', () => {
    it('filters by course, track, status, phase and search', async () => {
      const otherTrack = await makeTrack(admin, 'UI/UX Design');
      const otherCourse = await makeCourse(admin, otherTrack, 'Design Basics');

      await makeCohort(admin, courseId, { name: 'AI Future', startsOn: dayOffset(5), endsOn: dayOffset(50) });
      await makeCohort(admin, courseId, { name: 'AI Now', startsOn: dayOffset(-5), endsOn: dayOffset(50) });
      const past = await makeCohort(admin, courseId, { name: 'AI Past', startsOn: dayOffset(-60), endsOn: dayOffset(-10) });
      await makeCohort(admin, otherCourse, { name: 'Design Now', startsOn: dayOffset(-5), endsOn: dayOffset(50) });
      await admin.post(`${COHORTS}/${past}/archive`).expect(200);

      const names = async (query: string) =>
        (await admin.get(`${COHORTS}?${query}&sortBy=name&sortDir=asc`).expect(200)).body.items.map((c: { name: string }) => c.name);

      expect(await names(`courseId=${courseId}`)).toEqual(['AI Future', 'AI Now', 'AI Past']);
      expect(await names(`trackId=${otherTrack}`)).toEqual(['Design Now']);
      expect(await names('status=ARCHIVED')).toEqual(['AI Past']);
      expect(await names('phase=upcoming')).toEqual(['AI Future']);
      expect(await names('phase=running')).toEqual(['AI Now', 'Design Now']);
      expect(await names('phase=ended')).toEqual(['AI Past']);
      expect(await names('search=now')).toEqual(['AI Now', 'Design Now']);
      expect(await names(`courseId=${courseId}&phase=running&status=ACTIVE`)).toEqual(['AI Now']);
    });

    it('pages and sorts (newest start first by default)', async () => {
      for (let i = 1; i <= 5; i++) await makeCohort(admin, courseId, { name: `Cohort ${i}`, startsOn: dayOffset(i), endsOn: dayOffset(i + 30) });

      const first = await admin.get(`${COHORTS}?pageSize=2`).expect(200);
      expect(first.body).toMatchObject({ total: 5, totalPages: 3, page: 1 });
      expect(first.body.items.map((c: { name: string }) => c.name)).toEqual(['Cohort 5', 'Cohort 4']);
      expect((await admin.get(`${COHORTS}?pageSize=2&page=3`).expect(200)).body.items).toHaveLength(1);
    });

    it('rejects bad list parameters', async () => {
      for (const query of ['phase=soon', 'courseId=nope', 'trackId=nope', 'status=NOPE', 'sortBy=capacity', 'pageSize=101', 'foo=bar']) {
        await admin.get(`${COHORTS}?${query}`).expect(400);
      }
    });

    it('shows one cohort with its instructors; 404 for unknown and 400 for malformed ids', async () => {
      const cohortId = await makeCohort(admin, courseId);
      const t = await teacher();
      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t.id }).expect(200);

      const res = await admin.get(`${COHORTS}/${cohortId}`).expect(200);
      expect(res.body.cohort).toMatchObject({ id: cohortId, instructorCount: 1 });
      expect(res.body.instructors).toEqual([expect.objectContaining({ id: t.id, fullName: 'Tina Teacher', email: 'teacher@example.org', status: 'ACTIVE' })]);

      await admin.get(`${COHORTS}/${SOME_ID}`).expect(404);
      await admin.get(`${COHORTS}/not-a-uuid`).expect(400);
    });
  });

  // ------------------------------------------------------------------ update

  describe('update', () => {
    it('changes name, dates and capacity, and audits what changed', async () => {
      const id = await makeCohort(admin, courseId, { name: 'Old Name', startsOn: '2030-01-01', endsOn: '2030-06-01', capacity: 20 });

      const res = await admin.patch(`${COHORTS}/${id}`).send({ name: 'New  Name', startsOn: '2030-02-01', endsOn: '2030-07-01', capacity: 25 }).expect(200);
      expect(res.body.cohort).toMatchObject({ name: 'New Name', startsOn: '2030-02-01', endsOn: '2030-07-01', capacity: 25 });

      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'cohort.updated' } });
      expect(audit.metadata).toEqual({ changed: ['name', 'startsOn', 'endsOn', 'capacity'] });
    });

    it('can remove the capacity limit by sending null', async () => {
      const id = await makeCohort(admin, courseId, { capacity: 20 });
      const res = await admin.patch(`${COHORTS}/${id}`).send({ capacity: null }).expect(200);
      expect(res.body.cohort.capacity).toBeNull();
    });

    it('checks the dates TOGETHER with the ones already saved', async () => {
      const id = await makeCohort(admin, courseId, { startsOn: '2030-03-01', endsOn: '2030-06-01' });

      await admin.patch(`${COHORTS}/${id}`).send({ endsOn: '2030-02-01' }).expect(400); //   ends before the saved start
      await admin.patch(`${COHORTS}/${id}`).send({ startsOn: '2030-07-01' }).expect(400); // starts after the saved end
      await admin.patch(`${COHORTS}/${id}`).send({ startsOn: '2030-08-01', endsOn: '2030-09-01' }).expect(200); // moving both is fine

      expect(await kit.prisma.cohort.findUniqueOrThrow({ where: { id } })).toMatchObject({
        startsOn: new Date('2030-08-01T00:00:00Z'),
        endsOn: new Date('2030-09-01T00:00:00Z'),
      });
    });

    it('does nothing, and records nothing, when the values are unchanged', async () => {
      const id = await makeCohort(admin, courseId, { name: 'Same', startsOn: '2030-01-01', endsOn: '2030-06-01' });
      await admin.patch(`${COHORTS}/${id}`).send({ name: 'Same', startsOn: '2030-01-01' }).expect(200);
      expect(await auditActions({ action: 'cohort.updated' })).toEqual([]);
    });

    it('refuses a duplicate name, an empty update, forbidden fields, and edits to an archived cohort', async () => {
      await makeCohort(admin, courseId, { name: 'Taken' });
      const id = await makeCohort(admin, courseId, { name: 'Mine' });

      await admin.patch(`${COHORTS}/${id}`).send({ name: 'TAKEN' }).expect(409);
      await admin.patch(`${COHORTS}/${id}`).send({}).expect(400);
      await admin.patch(`${COHORTS}/${id}`).send({ courseId: SOME_ID }).expect(400); // cannot be moved to another course
      await admin.patch(`${COHORTS}/${id}`).send({ status: 'ARCHIVED' }).expect(400);
      await admin.patch(`${COHORTS}/${id}`).send({ capacity: 0 }).expect(400);
      await admin.patch(`${COHORTS}/${SOME_ID}`).send({ name: 'Ghost' }).expect(404);

      await admin.post(`${COHORTS}/${id}/archive`).expect(200);
      const blocked = await admin.patch(`${COHORTS}/${id}`).send({ name: 'Renamed' }).expect(409);
      expect(blocked.body.message).toContain('Restore it');
    });
  });

  // -------------------------------------------------------- archive / restore

  describe('archive and restore', () => {
    it('archives and restores, auditing both, and refuses repeats', async () => {
      const id = await makeCohort(admin, courseId);

      expect((await admin.post(`${COHORTS}/${id}/archive`).expect(200)).body.cohort.status).toBe('ARCHIVED');
      await admin.post(`${COHORTS}/${id}/archive`).expect(409);
      expect((await admin.post(`${COHORTS}/${id}/restore`).expect(200)).body.cohort.status).toBe('ACTIVE');
      await admin.post(`${COHORTS}/${id}/restore`).expect(409);
      expect(await auditActions({ action: { in: ['cohort.archived', 'cohort.restored'] } })).toEqual(['cohort.archived', 'cohort.restored']);
    });

    it('refuses to restore a cohort while its course is archived', async () => {
      const id = await makeCohort(admin, courseId);
      await admin.post(`${COHORTS}/${id}/archive`).expect(200);
      await admin.post(`/api/v1/admin/courses/${courseId}/archive`).expect(200);

      const blocked = await admin.post(`${COHORTS}/${id}/restore`).expect(409);
      expect(blocked.body.message).toContain('Restore the course first');

      await admin.post(`/api/v1/admin/courses/${courseId}/restore`).expect(200);
      await admin.post(`${COHORTS}/${id}/restore`).expect(200);
    });
  });

  // ------------------------------------------------- teaching assignments

  describe('assigning instructors', () => {
    it('assigns an active instructor, lists them, and audits it', async () => {
      const cohortId = await makeCohort(admin, courseId);
      const t = await teacher();

      const res = await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t.id }).expect(200);
      expect(res.body.instructors).toHaveLength(1);
      expect(res.body.instructors[0]).toMatchObject({ id: t.id, fullName: 'Tina Teacher' });

      const row = await kit.prisma.cohortInstructor.findFirstOrThrow();
      expect(row).toMatchObject({ cohortId, instructorId: t.id, assignedById: adminId });
      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'cohort.instructor_assigned' } });
      expect(audit).toMatchObject({ actorId: adminId, entityId: cohortId, metadata: { instructorId: t.id } });
    });

    it('lets several instructors share a cohort, and one instructor teach several cohorts', async () => {
      const cohortA = await makeCohort(admin, courseId, { name: 'Cohort A' });
      const cohortB = await makeCohort(admin, courseId, { name: 'Cohort B' });
      const t1 = await teacher('t1@example.org', 'Teacher One');
      const t2 = await teacher('t2@example.org', 'Teacher Two');

      await admin.post(`${COHORTS}/${cohortA}/instructors`).send({ instructorId: t1.id }).expect(200);
      await admin.post(`${COHORTS}/${cohortA}/instructors`).send({ instructorId: t2.id }).expect(200);
      await admin.post(`${COHORTS}/${cohortB}/instructors`).send({ instructorId: t1.id }).expect(200);

      expect((await admin.get(`${COHORTS}/${cohortA}`).expect(200)).body.cohort.instructorCount).toBe(2);
      expect(await kit.prisma.cohortInstructor.count({ where: { instructorId: t1.id } })).toBe(2);
    });

    it('allows an invited instructor (set up in advance) but refuses a suspended one', async () => {
      const cohortId = await makeCohort(admin, courseId);
      const invited = await kit.createUser({ email: 'invited@example.org', role: Role.INSTRUCTOR, status: AccountStatus.INVITED, withPassword: false });
      const suspended = await kit.createUser({ email: 'suspended@example.org', role: Role.INSTRUCTOR, status: AccountStatus.SUSPENDED });

      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: invited.id }).expect(200);
      const refused = await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: suspended.id }).expect(409);
      expect(refused.body.message).toContain('Suspended');
      expect(await kit.prisma.cohortInstructor.count()).toBe(1);
    });

    it('refuses students, admins, unknown people, an archived cohort, and malformed ids', async () => {
      const cohortId = await makeCohort(admin, courseId);
      const student = await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });

      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: student.id }).expect(404);
      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: adminId }).expect(404);
      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: SOME_ID }).expect(404);
      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: 'nope' }).expect(400);
      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({}).expect(400);
      await admin.post(`${COHORTS}/${SOME_ID}/instructors`).send({ instructorId: SOME_ID }).expect(404);

      const t = await teacher();
      await admin.post(`${COHORTS}/${cohortId}/archive`).expect(200);
      const blocked = await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t.id }).expect(409);
      expect(blocked.body.message).toContain('archived cohort');
      expect(await kit.prisma.cohortInstructor.count()).toBe(0);
    });

    it('refuses assigning the same instructor twice, even when both requests arrive together', async () => {
      const cohortId = await makeCohort(admin, courseId);
      const t = await teacher();

      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t.id }).expect(200);
      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t.id }).expect(409);

      const t2 = await teacher('t2@example.org', 'Teacher Two');
      const [a, b] = await Promise.all([
        admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t2.id }),
        admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t2.id }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await kit.prisma.cohortInstructor.count()).toBe(2);
    });
  });

  describe('removing instructors', () => {
    it('removes an assignment and audits it; refuses someone who is not assigned', async () => {
      const cohortId = await makeCohort(admin, courseId);
      const t = await teacher();
      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t.id }).expect(200);

      const res = await admin.delete(`${COHORTS}/${cohortId}/instructors/${t.id}`).expect(200);
      expect(res.body.instructors).toEqual([]);
      expect(await kit.prisma.cohortInstructor.count()).toBe(0);
      expect(await auditActions({ action: 'cohort.instructor_removed' })).toHaveLength(1);

      await admin.delete(`${COHORTS}/${cohortId}/instructors/${t.id}`).expect(404);
      await admin.delete(`${COHORTS}/${SOME_ID}/instructors/${t.id}`).expect(404);
      await admin.delete(`${COHORTS}/${cohortId}/instructors/not-a-uuid`).expect(400);
    });

    it('still works on an archived cohort', async () => {
      const cohortId = await makeCohort(admin, courseId);
      const t = await teacher();
      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t.id }).expect(200);
      await admin.post(`${COHORTS}/${cohortId}/archive`).expect(200);

      await admin.delete(`${COHORTS}/${cohortId}/instructors/${t.id}`).expect(200);
      expect((await kit.prisma.cohort.findUniqueOrThrow({ where: { id: cohortId } })).status).toBe(CohortStatus.ARCHIVED);
    });
  });

  it('records every cohort action in order, with who did it', async () => {
    const cohortId = await makeCohort(admin, courseId); // (the track and course already exist from set-up)
    const t = await teacher();
    await admin.patch(`${COHORTS}/${cohortId}`).send({ capacity: 40 }).expect(200);
    await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: t.id }).expect(200);
    await admin.delete(`${COHORTS}/${cohortId}/instructors/${t.id}`).expect(200);
    await admin.post(`${COHORTS}/${cohortId}/archive`).expect(200);
    await admin.post(`${COHORTS}/${cohortId}/restore`).expect(200);

    const rows = await kit.prisma.auditLog.findMany({ where: { actorId: adminId, entityId: cohortId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual([
      'cohort.created',
      'cohort.updated',
      'cohort.instructor_assigned',
      'cohort.instructor_removed',
      'cohort.archived',
      'cohort.restored',
    ]);
  });
});