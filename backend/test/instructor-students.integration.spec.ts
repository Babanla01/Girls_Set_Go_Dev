/**
 * instructor-students.integration.spec.ts
 * ---------------------------------------------------------------------------
 * What an INSTRUCTOR sees of the students in one of HER cohorts: names only.
 * Someone else's cohort looks exactly like one that does not exist.
 * Real app, PostgreSQL and Redis (the TEST ones).
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { EnrollmentStatus, Role } from '@prisma/client';
import request from 'supertest';

import { makeCohort, makeStack } from './helpers/catalog-helpers';
import { enroll, makeApplicant } from './helpers/student-helpers';
import { createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const MINE = '/api/v1/instructor/cohorts';
const COHORTS = '/api/v1/admin/cohorts';
const SOME_ID = '11111111-1111-4111-8111-111111111111';

const said = (res: { body: unknown }) => JSON.stringify(res.body);

describe('Instructor: students in my cohort (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;
  let tina: TestAgent; // assigned to the cohort
  let bob: TestAgent; // an instructor with no cohorts
  let tinaId: string;
  let bobId: string;
  let trackId: string;
  let courseId: string;
  let cohortId: string;

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    await kit.createUser({ email: 'admin@example.org', fullName: 'Pat Admin', role: Role.ADMIN });
    tinaId = (await kit.createUser({ email: 'tina@example.org', fullName: 'Tina Teacher', role: Role.INSTRUCTOR })).id;
    bobId = (await kit.createUser({ email: 'bob@example.org', fullName: 'Bob Teacher', role: Role.INSTRUCTOR })).id;
    admin = await kit.loginAgent('admin@example.org', 'admin');
    ({ trackId, courseId, cohortId } = await makeStack(admin));

    await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: tinaId }).expect(200);
    tina = await kit.loginAgent('tina@example.org', 'instructor');
    bob = await kit.loginAgent('bob@example.org', 'instructor');
  });

  const girl = (name: string, email: string) => makeApplicant(kit, trackId, { fullName: name, email, withGuardian: true });

  /** Zainab and Amaka are enrolled; Chioma left; Ngozi is in a different cohort. */
  const seedStudents = async () => {
    const [zainab, amaka, chioma, ngozi] = await Promise.all([
      girl('Zainab Bello', 'zainab@example.org'),
      girl('Amaka Eze', 'amaka@example.org'),
      girl('Chioma Obi', 'chioma@example.org'),
      girl('Ngozi Ade', 'ngozi@example.org'),
    ]);
    const otherCohort = await makeCohort(admin, courseId, { name: 'Other Cohort' });

    await enroll(kit, zainab.studentId, cohortId);
    await enroll(kit, amaka.studentId, cohortId);
    await enroll(kit, chioma.studentId, cohortId, { status: EnrollmentStatus.WITHDRAWN });
    await enroll(kit, ngozi.studentId, otherCohort);

    return { zainab, amaka, chioma, ngozi, otherCohort };
  };

  const names = (res: { body: { items: { fullName: string }[] } }) => res.body.items.map((item) => item.fullName);

  // ---------------------------------------------------------- who may use it

  it('refuses signed-out visitors (401), students (403) and admins (403)', async () => {
    await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
    const student = await kit.loginAgent('student@example.org', 'student');
    const path = `${MINE}/${cohortId}/students`;

    await request(kit.server()).get(path).expect(401);
    await student.get(path).expect(403);
    await admin.get(path).expect(403);
  });

  // -------------------------------------------------------------- the list

  it('lists the students enrolled in her cohort, by name', async () => {
    await seedStudents();

    const res = await tina.get(`${MINE}/${cohortId}/students`).expect(200);

    expect(names(res)).toEqual(['Amaka Eze', 'Zainab Bello']); // not Chioma (left) or Ngozi (another cohort)
    expect(res.body).toMatchObject({ total: 2, page: 1, totalPages: 1 });
  });

  it('shows names only: each entry is just an id, a name and the date she joined', async () => {
    await seedStudents();

    const res = await tina.get(`${MINE}/${cohortId}/students`).expect(200);

    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(['enrolledAt', 'fullName', 'id']);
      expect(item.enrolledAt).toEqual(expect.any(String));
    }
  });

  it('never reveals emails, phone numbers, birth dates, schools or guardian details', async () => {
    await seedStudents();

    const body = said(await tina.get(`${MINE}/${cohortId}/students`).expect(200));

    for (const hidden of [
      'email',
      'phone',
      'amaka@example.org',
      'zainab@example.org',
      '08012345678',
      '2000-05-05',
      'Government College',
      'Lagos',
      'guardian',
      'Mrs Okoye',
      'mum@example.org',
    ]) {
      expect(body).not.toContain(hidden);
    }
  });

  it('is empty for a cohort nobody has joined yet', async () => {
    const res = await tina.get(`${MINE}/${cohortId}/students`).expect(200);
    expect(res.body).toMatchObject({ items: [], total: 0 });
  });

  it('pages the results', async () => {
    await seedStudents();

    const second = await tina.get(`${MINE}/${cohortId}/students?pageSize=1&page=2`).expect(200);

    expect(names(second)).toEqual(['Zainab Bello']);
    expect(second.body).toMatchObject({ total: 2, totalPages: 2, page: 2, pageSize: 1 });
  });

  it('follows changes: a student who leaves disappears and a new one appears', async () => {
    const { amaka } = await seedStudents();
    await kit.prisma.enrollment.updateMany({
      where: { studentId: amaka.studentId },
      data: { status: EnrollmentStatus.WITHDRAWN, endedAt: new Date() },
    });
    const bisi = await girl('Bisi Lawal', 'bisi@example.org');
    await enroll(kit, bisi.studentId, cohortId);

    const res = await tina.get(`${MINE}/${cohortId}/students`).expect(200);
    expect(names(res)).toEqual(['Bisi Lawal', 'Zainab Bello']);
  });

  // -------------------------------------------------------------- ownership

  describe('whose cohort it is', () => {
    it("treats another instructor's cohort exactly like one that does not exist", async () => {
      await seedStudents();

      const notMine = await bob.get(`${MINE}/${cohortId}/students`).expect(404);
      const missing = await bob.get(`${MINE}/${SOME_ID}/students`).expect(404);

      expect(said(notMine)).toContain('Cohort not found.');
      expect(said(missing)).toContain('Cohort not found.');
      expect(said(notMine)).not.toContain('Zainab');
    });

    it('answers 400 for something that is not an id', async () => {
      await tina.get(`${MINE}/not-an-id/students`).expect(400);
    });

    it('lets an instructor see her cohort only while she is assigned to it', async () => {
      await seedStudents();
      await tina.get(`${MINE}/${cohortId}/students`).expect(200);

      await admin.delete(`${COHORTS}/${cohortId}/instructors/${tinaId}`).expect(200);

      await tina.get(`${MINE}/${cohortId}/students`).expect(404); // from her very next request
    });

    it('shows a second instructor the same students once she is assigned too', async () => {
      await seedStudents();
      await bob.get(`${MINE}/${cohortId}/students`).expect(404);

      await admin.post(`${COHORTS}/${cohortId}/instructors`).send({ instructorId: bobId }).expect(200);

      expect(names(await bob.get(`${MINE}/${cohortId}/students`).expect(200))).toEqual(['Amaka Eze', 'Zainab Bello']);
    });
  });

  // ----------------------------------------------------- the cohort itself

  describe('the cohort pages', () => {
    it('report how many students are enrolled, counting only those still enrolled', async () => {
      await seedStudents();

      const one = await tina.get(`${MINE}/${cohortId}`).expect(200);
      expect(one.body.cohort.enrolledCount).toBe(2);

      const list = await tina.get(MINE).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: cohortId, enrolledCount: 2 });
    });

    it('still list co-instructors by name only', async () => {
      const res = await tina.get(`${MINE}/${cohortId}`).expect(200);
      expect(res.body.instructors).toEqual([{ id: tinaId, fullName: 'Tina Teacher' }]);
    });
  });
});