/**
 * instructor-cohorts.integration.spec.ts
 * ---------------------------------------------------------------------------
 * What an INSTRUCTOR may see: only their own cohorts. This is the first real
 * use of the ownership rules from Batch 3. Real app, PostgreSQL and Redis.
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { AccountStatus, Role } from '@prisma/client';
import request from 'supertest';

import { dayOffset, makeCohort, makeCourse, makeTrack } from './helpers/catalog-helpers';
import { createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const MINE = '/api/v1/instructor/cohorts';
const COHORTS = '/api/v1/admin/cohorts';
const SOME_ID = '11111111-1111-4111-8111-111111111111';

describe('Instructor: my cohorts (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;
  let courseId: string;
  let tinaId: string;
  let tina: TestAgent;
  let bobId: string;
  let bob: TestAgent;

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    await kit.createUser({ email: 'admin@example.org', fullName: 'Ada Admin', role: Role.ADMIN });
    tinaId = (await kit.createUser({ email: 'tina@example.org', fullName: 'Tina Teacher', role: Role.INSTRUCTOR })).id;
    bobId = (await kit.createUser({ email: 'bob@example.org', fullName: 'Bob Teacher', role: Role.INSTRUCTOR })).id;
    admin = await kit.loginAgent('admin@example.org', 'admin');
    tina = await kit.loginAgent('tina@example.org', 'instructor');
    bob = await kit.loginAgent('bob@example.org', 'instructor');
    courseId = await makeCourse(admin, await makeTrack(admin));
  });

  const assign = (cohortId: string, instructorId: string) =>
    admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId }).expect(200);

  // ---------------------------------------------------- who may use these routes

  it('refuses signed-out visitors (401), students (403) and even admins (403)', async () => {
    await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
    const student = await kit.loginAgent('student@example.org', 'student');

    await request(kit.server()).get(MINE).expect(401);
    await request(kit.server()).get(`${MINE}/${SOME_ID}`).expect(401);
    await student.get(MINE).expect(403);
    await student.get(`${MINE}/${SOME_ID}`).expect(403);
    await admin.get(MINE).expect(403); // admins use the admin routes
  });

  // -------------------------------------------------------------------- list

  describe('list', () => {
    it('shows an instructor ONLY the cohorts assigned to them', async () => {
      const mine = await makeCohort(admin, courseId, { name: 'Tina Cohort' });
      const shared = await makeCohort(admin, courseId, { name: 'Shared Cohort' });
      const notMine = await makeCohort(admin, courseId, { name: 'Bob Cohort' });
      await makeCohort(admin, courseId, { name: 'Nobody Cohort' });
      await assign(mine, tinaId);
      await assign(shared, tinaId);
      await assign(shared, bobId);
      await assign(notMine, bobId);

      const tinas = await tina.get(MINE).expect(200);
      expect(tinas.body.items.map((c: { name: string }) => c.name).sort()).toEqual(['Shared Cohort', 'Tina Cohort']);
      expect(tinas.body.total).toBe(2);

      const bobs = await bob.get(MINE).expect(200);
      expect(bobs.body.items.map((c: { name: string }) => c.name).sort()).toEqual(['Bob Cohort', 'Shared Cohort']);
    });

    it('includes the course, track, dates and phase', async () => {
      const id = await makeCohort(admin, courseId, { name: 'Running Now', startsOn: dayOffset(-3), endsOn: dayOffset(40), capacity: 25 });
      await assign(id, tinaId);

      const res = await tina.get(MINE).expect(200);
      expect(res.body.items[0]).toMatchObject({
        name: 'Running Now',
        phase: 'running',
        capacity: 25,
        course: { title: 'Intro to AI' },
        track: { name: 'AI & Robotics' },
      });
    });

    it('shows active cohorts by default, archived ones on request, and pages', async () => {
      const active = await makeCohort(admin, courseId, { name: 'Active One' });
      const archived = await makeCohort(admin, courseId, { name: 'Archived One' });
      await assign(active, tinaId);
      await assign(archived, tinaId);
      await admin.post(`${COHORTS}/${archived}/archive`).expect(200);

      expect((await tina.get(MINE).expect(200)).body.items.map((c: { name: string }) => c.name)).toEqual(['Active One']);
      expect((await tina.get(`${MINE}?status=ARCHIVED`).expect(200)).body.items.map((c: { name: string }) => c.name)).toEqual(['Archived One']);
      expect((await tina.get(`${MINE}?pageSize=1&page=2`).expect(200)).body.items).toEqual([]);
    });

    it('returns an empty list for an instructor with no assignments, and rejects bad parameters', async () => {
      await makeCohort(admin, courseId);
      expect((await tina.get(MINE).expect(200)).body).toMatchObject({ items: [], total: 0 });

      for (const query of ['status=NOPE', 'pageSize=101', 'foo=bar', 'instructorId=' + bobId]) {
        await tina.get(`${MINE}?${query}`).expect(400); // cannot ask to see someone else's list
      }
    });
  });

  // ------------------------------------------------------------------ detail

  describe('detail', () => {
    it('shows an assigned cohort, with colleagues listed by NAME only', async () => {
      const id = await makeCohort(admin, courseId, { name: 'Shared Cohort' });
      await assign(id, tinaId);
      await assign(id, bobId);

      const res = await tina.get(`${MINE}/${id}`).expect(200);
      expect(res.body.cohort).toMatchObject({ id, name: 'Shared Cohort', instructorCount: 2 });
      expect(res.body.instructors).toEqual([
        { id: tinaId, fullName: 'Tina Teacher' },
        { id: bobId, fullName: 'Bob Teacher' },
      ]);
      expect(JSON.stringify(res.body)).not.toContain('@example.org'); // no email addresses
    });

    it("makes someone else's cohort look exactly like one that does not exist", async () => {
      const bobsCohort = await makeCohort(admin, courseId, { name: 'Bob Cohort' });
      await assign(bobsCohort, bobId);

      const notMine = await tina.get(`${MINE}/${bobsCohort}`).expect(404);
      const missing = await tina.get(`${MINE}/${SOME_ID}`).expect(404);
      expect(notMine.body.message).toBe(missing.body.message); // identical answer: nothing to learn
      await tina.get(`${MINE}/not-a-uuid`).expect(400);
    });

    it('still shows an assigned cohort after it is archived (with its status)', async () => {
      const id = await makeCohort(admin, courseId);
      await assign(id, tinaId);
      await admin.post(`${COHORTS}/${id}/archive`).expect(200);

      expect((await tina.get(`${MINE}/${id}`).expect(200)).body.cohort.status).toBe('ARCHIVED');
    });
  });

  // ---------------------------------------------- access follows the admin

  describe('access follows what the admin does', () => {
    it('is cut on the very next request when an admin removes the assignment', async () => {
      const id = await makeCohort(admin, courseId);
      await assign(id, tinaId);
      await tina.get(`${MINE}/${id}`).expect(200);
      expect((await tina.get(MINE).expect(200)).body.total).toBe(1);

      await admin.delete(`${COHORTS}/${id}/instructors/${tinaId}`).expect(200);

      await tina.get(`${MINE}/${id}`).expect(404); // no waiting, no stale access
      expect((await tina.get(MINE).expect(200)).body.total).toBe(0);
    });

    it('appears on the very next request when an admin assigns the instructor', async () => {
      const id = await makeCohort(admin, courseId);
      await tina.get(`${MINE}/${id}`).expect(404);

      await assign(id, tinaId);

      await tina.get(`${MINE}/${id}`).expect(200);
    });

    it('survives a suspension: assignments are kept and work again after reactivation', async () => {
      const id = await makeCohort(admin, courseId);
      await assign(id, tinaId);

      await admin.post(`/api/v1/admin/instructors/${tinaId}/suspend`).expect(200);
      await tina.get(MINE).expect(401); // suspended: signed out immediately
      expect(await kit.prisma.cohortInstructor.count({ where: { instructorId: tinaId } })).toBe(1); // assignment kept

      await admin.post(`/api/v1/admin/instructors/${tinaId}/reactivate`).expect(200);
      const again = await kit.loginAgent('tina@example.org', 'instructor');
      expect((await again.get(MINE).expect(200)).body.items.map((c: { id: string }) => c.id)).toEqual([id]);
    });

    it('lets an invited instructor who was pre-assigned see the cohort once they have signed in', async () => {
      const id = await makeCohort(admin, courseId);
      const newcomer = await kit.createUser({ email: 'new@example.org', fullName: 'New Teacher', role: Role.INSTRUCTOR, status: AccountStatus.INVITED, withPassword: false });
      await assign(id, newcomer.id);

      await kit.prisma.user.update({ where: { id: newcomer.id }, data: { status: AccountStatus.ACTIVE, passwordHash: kit.goodHash } }); // (as if they accepted the invite)
      const browser = await kit.loginAgent('new@example.org', 'instructor');
      expect((await browser.get(`${MINE}/${id}`).expect(200)).body.cohort.id).toBe(id);
    });
  });
});