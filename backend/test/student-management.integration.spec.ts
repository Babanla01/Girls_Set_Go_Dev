/**
 * student-management.integration.spec.ts
 * ---------------------------------------------------------------------------
 * What an ADMIN can DO to a student: edit her details, suspend and reactivate
 * her account, withdraw her from her cohort, and move her to another cohort -
 * including the "two admins at once" cases. Real app, PostgreSQL and Redis
 * (the TEST ones).
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { AccountStatus, EnrollmentStatus, Role } from '@prisma/client';
import request from 'supertest';

import { REMOVED_ACCOUNT_MESSAGE, removedAccountEmail } from '../src/retention/retention.constants';
import { NOT_ENROLLED_MESSAGE } from '../src/admin/students/student-management.service';
import { GUARDIAN_PARTIAL_MESSAGE, GUARDIAN_REQUIRED_MESSAGE } from '../src/students/students.constants';
import { dayOffset, makeCohort, makeCourse, makeStack, makeTrack } from './helpers/catalog-helpers';
import { makeApplicant } from './helpers/student-helpers';
import { createTestKit, GOOD_PASSWORD, TestAgent, TestKit } from './helpers/test-kit';

const STUDENTS = '/api/v1/admin/students';
const APPLICATIONS = '/api/v1/admin/applications';
const DASHBOARD = '/api/v1/students/me/dashboard';
const LOGIN = '/api/v1/auth/login';
const SOME_ID = '11111111-1111-4111-8111-111111111111';

const said = (res: { body: unknown }) => JSON.stringify(res.body);
const statuses = (...responses: Array<{ status: number }>) => responses.map((r) => r.status).sort((a, b) => a - b);

/** A date of birth that makes her about 15 years old today. */
const minorDob = () => dayOffset(-(15 * 365 + 4));

describe('Admin: managing students (integration)', () => {
  let kit: TestKit;
  let adminOne: TestAgent;
  let adminTwo: TestAgent;
  let adminId: string;
  let teacherId: string;
  let trackId: string;
  let courseId: string;
  let cohortId: string; // "Cohort 1"

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    adminId = (await kit.createUser({ email: 'admin1@example.org', fullName: 'Pat Admin', role: Role.ADMIN })).id;
    await kit.createUser({ email: 'admin2@example.org', fullName: 'Sam Admin', role: Role.ADMIN });
    teacherId = (await kit.createUser({ email: 'teacher@example.org', fullName: 'Tina Teacher', role: Role.INSTRUCTOR })).id;
    adminOne = await kit.loginAgent('admin1@example.org', 'admin');
    adminTwo = await kit.loginAgent('admin2@example.org', 'admin');
    ({ trackId, courseId, cohortId } = await makeStack(adminOne));
  });

  // ----------------------------------------------------------------- helpers

  const applicant = (name = 'Ada Okoye', email = 'ada@example.org') => makeApplicant(kit, trackId, { fullName: name, email });

  /** An applicant who is already accepted and enrolled in `into`. */
  const enrolled = async (name: string, email: string, into: string = cohortId) => {
    const person = await applicant(name, email);
    await adminOne.post(`${APPLICATIONS}/${person.applicationId}/accept`).send({ cohortId: into }).expect(200);
    return person;
  };

  const patch = (who: TestAgent, studentId: string, body: Record<string, unknown>) =>
    who.patch(`${STUDENTS}/${studentId}`).send(body);
  const suspend = (who: TestAgent, studentId: string) => who.post(`${STUDENTS}/${studentId}/suspend`);
  const reactivate = (who: TestAgent, studentId: string) => who.post(`${STUDENTS}/${studentId}/reactivate`);
  const withdraw = (who: TestAgent, studentId: string) => who.post(`${STUDENTS}/${studentId}/withdraw`);
  const move = (who: TestAgent, studentId: string, cohort: string) =>
    who.post(`${STUDENTS}/${studentId}/move`).send({ cohortId: cohort });

  const activeEnrollments = (studentId: string) =>
    kit.prisma.enrollment.findMany({ where: { studentId, status: EnrollmentStatus.ACTIVE } });

  const auditOf = (action: string) => kit.prisma.auditLog.findMany({ where: { action } });

  // -------------------------------------------------------- who may use it

  it('refuses signed-out visitors (401), students (403) and instructors (403) on every management route', async () => {
    await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
    const student = await kit.loginAgent('student@example.org', 'student');
    const teacher = await kit.loginAgent('teacher@example.org', 'instructor');

    const routes: Array<['patch' | 'post', string]> = [
      ['patch', `${STUDENTS}/${SOME_ID}`],
      ['post', `${STUDENTS}/${SOME_ID}/suspend`],
      ['post', `${STUDENTS}/${SOME_ID}/reactivate`],
      ['post', `${STUDENTS}/${SOME_ID}/withdraw`],
      ['post', `${STUDENTS}/${SOME_ID}/move`],
    ];

    for (const [method, path] of routes) {
      await request(kit.server())[method](path).expect(401);
      await student[method](path).expect(403);
      await teacher[method](path).expect(403);
    }
  });

  it('answers 404 for an admin, an instructor or an unknown id, and 400 for a malformed id', async () => {
    for (const id of [adminId, teacherId, SOME_ID]) {
      await patch(adminOne, id, { phone: '08011112222' }).expect(404);
      await suspend(adminOne, id).expect(404);
      await reactivate(adminOne, id).expect(404);
      await withdraw(adminOne, id).expect(404);
      await move(adminOne, id, cohortId).expect(404);
    }
    await patch(adminOne, 'not-an-id', { phone: '08011112222' }).expect(400);
    await suspend(adminOne, 'not-an-id').expect(400);
  });

  // -------------------------------------------------------------------- edit

  describe('editing a student', () => {
    it('changes her name and profile details, and shows the result', async () => {
      const ada = await applicant();

      const res = await patch(adminOne, ada.studentId, {
        fullName: '  Ada   Obi ',
        phone: '08099999999',
        location: 'Abuja',
        schoolName: 'New School',
        gradeLevel: 'SS3',
      }).expect(200);

      expect(res.body.student).toMatchObject({
        id: ada.studentId,
        fullName: 'Ada Obi', // spaces tidied
        email: 'ada@example.org', // untouched
        profile: { phone: '08099999999', location: 'Abuja', schoolName: 'New School', gradeLevel: 'SS3', dateOfBirth: '2000-05-05' },
      });
      expect((await kit.prisma.user.findUniqueOrThrow({ where: { id: ada.studentId } })).fullName).toBe('Ada Obi');
    });

    it('audits the change with the NAMES of the fields only, never the values', async () => {
      const ada = await applicant();
      await patch(adminOne, ada.studentId, {
        fullName: 'Ada Obi',
        phone: '08099999999',
        location: 'Abuja',
        schoolName: 'New School',
        gradeLevel: 'SS3',
      }).expect(200);

      const [audit] = await auditOf('student.updated');
      expect(audit).toMatchObject({ actorId: adminId, entityType: 'user', entityId: ada.studentId });
      expect([...(audit.metadata as { changed: string[] }).changed].sort()).toEqual([
        'fullName',
        'gradeLevel',
        'location',
        'phone',
        'schoolName',
      ]);

      const everything = JSON.stringify(await kit.prisma.auditLog.findMany());
      for (const secret of ['Ada Obi', '08099999999', 'Abuja', 'New School', 'ada@example.org']) {
        expect(everything).not.toContain(secret);
      }
    });

    it('changes just one field when only one is sent', async () => {
      const ada = await applicant();
      await patch(adminOne, ada.studentId, { phone: '08011112222' }).expect(200);

      const [audit] = await auditOf('student.updated');
      expect((audit.metadata as { changed: string[] }).changed).toEqual(['phone']);

      const profile = await kit.prisma.studentProfile.findUniqueOrThrow({ where: { userId: ada.studentId } });
      expect(profile).toMatchObject({ phone: '08011112222', location: 'Lagos', schoolName: 'Government College' });
    });

    it('does nothing, and writes no audit entry, when nothing really changes', async () => {
      const ada = await applicant();

      await patch(adminOne, ada.studentId, { fullName: 'Ada Okoye', phone: '08012345678', location: 'Lagos' }).expect(200);

      expect(await auditOf('student.updated')).toHaveLength(0);
    });

    it('refuses to change her email, date of birth, role, status or password', async () => {
      const ada = await applicant();

      for (const body of [
        { email: 'new@example.org' },
        { dateOfBirth: '2001-01-01' },
        { role: 'ADMIN' },
        { status: 'SUSPENDED' },
        { passwordHash: 'x' },
        { password: 'Sunny-Garden-42!' },
        { emailVerifiedAt: '2020-01-01T00:00:00.000Z' },
      ]) {
        await patch(adminOne, ada.studentId, body).expect(400);
      }

      const user = await kit.prisma.user.findUniqueOrThrow({ where: { id: ada.studentId } });
      expect(user).toMatchObject({ email: 'ada@example.org', role: 'STUDENT', status: 'ACTIVE' });
    });

    it('refuses an empty request', async () => {
      const ada = await applicant();
      const empty = await patch(adminOne, ada.studentId, {}).expect(400);
      expect(said(empty)).toContain('Nothing to update.');
      await patch(adminOne, ada.studentId, { fullName: '   ' }).expect(400); // blank counts as "not sent"
    });

    it('applies the same field rules as signup', async () => {
      const ada = await applicant();

      for (const body of [
        { fullName: 'A' },
        { fullName: 'A'.repeat(121) },
        { fullName: null },
        { phone: 'call me' },
        { phone: null },
        { location: 'L' },
        { schoolName: null },
        { gradeLevel: 'G'.repeat(51) },
        { guardianEmail: 'not-an-email' },
        { guardianPhone: 'abc' },
        { guardianName: 'M' },
      ]) {
        await patch(adminOne, ada.studentId, body).expect(400);
      }
    });

    describe('the guardian', () => {
      const guardian = { guardianName: 'Mrs Okoye', guardianEmail: '  MUM@Example.ORG ', guardianPhone: '08098765432' };

      it('can be added to an adult, with the email tidied to lowercase', async () => {
        const ada = await applicant();

        const res = await patch(adminOne, ada.studentId, guardian).expect(200);

        expect(res.body.student.profile.guardian).toEqual({
          name: 'Mrs Okoye',
          email: 'mum@example.org',
          phone: '08098765432',
        });
      });

      it('must be given in full or not at all', async () => {
        const ada = await applicant();

        for (const body of [{ guardianName: 'Mrs Okoye' }, { guardianName: 'Mrs Okoye', guardianEmail: 'mum@example.org' }]) {
          const res = await patch(adminOne, ada.studentId, body).expect(400);
          expect(said(res)).toContain(GUARDIAN_PARTIAL_MESSAGE);
        }
        expect((await kit.prisma.studentProfile.findUniqueOrThrow({ where: { userId: ada.studentId } })).guardianName).toBeNull();
      });

      it('can be removed from an adult by sending null for all three', async () => {
        const ada = await makeApplicant(kit, trackId, { withGuardian: true });

        const res = await patch(adminOne, ada.studentId, {
          guardianName: null,
          guardianEmail: null,
          guardianPhone: null,
        }).expect(200);

        expect(res.body.student.profile.guardian).toBeNull();
      });

      it('cannot be removed halfway', async () => {
        const ada = await makeApplicant(kit, trackId, { withGuardian: true });

        const res = await patch(adminOne, ada.studentId, { guardianPhone: null }).expect(400);
        expect(said(res)).toContain(GUARDIAN_PARTIAL_MESSAGE);
      });

      describe('of a student under 18', () => {
        const minor = async () => {
          const girl = await makeApplicant(kit, trackId, { fullName: 'Young Girl', email: 'young@example.org', withGuardian: true });
          await kit.prisma.studentProfile.update({ where: { userId: girl.studentId }, data: { dateOfBirth: new Date(minorDob()) } });
          return girl;
        };

        it('can be changed, but never removed', async () => {
          const girl = await minor();

          const removed = await patch(adminOne, girl.studentId, {
            guardianName: null,
            guardianEmail: null,
            guardianPhone: null,
          }).expect(400);
          expect(said(removed)).toContain(GUARDIAN_REQUIRED_MESSAGE);

          const changed = await patch(adminOne, girl.studentId, { guardianPhone: '08077778888' }).expect(200);
          expect(changed.body.student.profile.guardian).toMatchObject({ name: 'Mrs Okoye', phone: '08077778888' });
        });

        it('does not stop her other details being edited', async () => {
          const girl = await minor();
          await patch(adminOne, girl.studentId, { location: 'Ibadan' }).expect(200);
        });
      });
    });

    it('is refused for a student who has no profile', async () => {
      const bare = await kit.createUser({ email: 'bare@example.org', role: Role.STUDENT });
      const res = await patch(adminOne, bare.id, { phone: '08011112222' }).expect(409);
      expect(said(res)).toContain('no profile');
    });

    it('is refused once her personal data has been removed', async () => {
      const gone = await applicant();
      await kit.prisma.user.update({ where: { id: gone.studentId }, data: { email: removedAccountEmail(gone.studentId) } });

      const res = await patch(adminOne, gone.studentId, { phone: '08011112222' }).expect(409);
      expect(said(res)).toContain(REMOVED_ACCOUNT_MESSAGE);
    });
  });

  // ------------------------------------------------------ suspend / reactivate

  describe('suspending and reactivating', () => {
    it('suspends the account and signs her out everywhere at once', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      const session = await kit.loginAgent('ada@example.org', 'student');
      await session.get(DASHBOARD).expect(200);

      const res = await suspend(adminOne, ada.studentId).expect(200);

      expect(res.body.student).toMatchObject({ id: ada.studentId, accountStatus: 'SUSPENDED' });
      expect((await kit.prisma.user.findUniqueOrThrow({ where: { id: ada.studentId } })).status).toBe(AccountStatus.SUSPENDED);
      await session.get(DASHBOARD).expect(401); // her open session stopped working immediately

      const login = await kit.agent().post(LOGIN).send({ email: 'ada@example.org', password: GOOD_PASSWORD, portal: 'student' });
      expect([401, 403]).toContain(login.status);
    });

    it('is audited, with no personal details', async () => {
      const ada = await applicant();
      await suspend(adminOne, ada.studentId).expect(200);

      const [audit] = await auditOf('student.suspended');
      expect(audit).toMatchObject({ actorId: adminId, entityType: 'user', entityId: ada.studentId });
      expect(JSON.stringify(audit)).not.toContain('ada@example.org');
      expect(JSON.stringify(audit)).not.toContain('Ada Okoye');
    });

    it('cannot be done twice', async () => {
      const ada = await applicant();
      await suspend(adminOne, ada.studentId).expect(200);

      const again = await suspend(adminOne, ada.studentId).expect(409);
      expect(said(again)).toContain('already suspended');
      expect(await auditOf('student.suspended')).toHaveLength(1);
    });

    it('can be undone: she can sign in again, and keeps her place in her cohort', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      await suspend(adminOne, ada.studentId).expect(200);

      const res = await reactivate(adminOne, ada.studentId).expect(200);
      expect(res.body.student).toMatchObject({ accountStatus: 'ACTIVE' });

      const session = await kit.loginAgent('ada@example.org', 'student');
      const dashboard = await session.get(DASHBOARD).expect(200);
      expect(dashboard.body).toMatchObject({ courseAccess: 'unlocked', enrollment: { cohort: { id: cohortId } } });

      const [audit] = await auditOf('student.reactivated');
      expect(audit).toMatchObject({ actorId: adminId, entityId: ada.studentId });
    });

    it('only reactivates a suspended student', async () => {
      const ada = await applicant();
      const res = await reactivate(adminOne, ada.studentId).expect(409);
      expect(said(res)).toContain('Only suspended students can be reactivated.');
      expect(await auditOf('student.reactivated')).toHaveLength(0);
    });

    it('will not reactivate an account whose personal data has been removed', async () => {
      const gone = await applicant();
      await kit.prisma.user.update({
        where: { id: gone.studentId },
        data: { email: removedAccountEmail(gone.studentId), passwordHash: null, status: AccountStatus.SUSPENDED },
      });

      const res = await reactivate(adminOne, gone.studentId).expect(409);
      expect(said(res)).toContain(REMOVED_ACCOUNT_MESSAGE);
      expect((await kit.prisma.user.findUniqueOrThrow({ where: { id: gone.studentId } })).status).toBe(AccountStatus.SUSPENDED);
    });
  });

  // ---------------------------------------------------------------- withdraw

  describe('withdrawing a student', () => {
    it('ends her enrollment, locks her course, and keeps the history', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      const session = await kit.loginAgent('ada@example.org', 'student');

      const res = await withdraw(adminOne, ada.studentId).expect(200);

      expect(res.body.student.enrollments).toHaveLength(1);
      expect(res.body.student.enrollments[0]).toMatchObject({ status: 'WITHDRAWN', cohort: { id: cohortId } });
      expect(res.body.student.enrollments[0].endedAt).toEqual(expect.any(String));

      expect(await activeEnrollments(ada.studentId)).toHaveLength(0);
      expect((await session.get(DASHBOARD).expect(200)).body).toMatchObject({ courseAccess: 'locked', enrollment: null });
    });

    it('is audited with the cohort and enrollment ids', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      const enrollment = (await kit.prisma.enrollment.findFirstOrThrow({ where: { studentId: ada.studentId } }));

      await withdraw(adminOne, ada.studentId).expect(200);

      const [audit] = await auditOf('student.withdrawn');
      expect(audit).toMatchObject({
        actorId: adminId,
        entityId: ada.studentId,
        metadata: { cohortId, enrollmentId: enrollment.id },
      });
    });

    it('frees the seat and lets the cohort be archived', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      await adminOne.post(`/api/v1/admin/cohorts/${cohortId}/archive`).expect(409); // still has her

      await withdraw(adminOne, ada.studentId).expect(200);

      const detail = await adminOne.get(`/api/v1/admin/cohorts/${cohortId}`).expect(200);
      expect(detail.body.cohort.enrolledCount).toBe(0);
      await adminOne.post(`/api/v1/admin/cohorts/${cohortId}/archive`).expect(200);
    });

    it('is refused for a student who is not enrolled, and cannot be done twice', async () => {
      const waiting = await applicant('Waiting Girl', 'waiting@example.org');
      expect(said(await withdraw(adminOne, waiting.studentId).expect(409))).toContain(NOT_ENROLLED_MESSAGE);

      const ada = await enrolled('Ada Okoye', 'ada@example.org', cohortId);
      await withdraw(adminOne, ada.studentId).expect(200);
      expect(said(await withdraw(adminOne, ada.studentId).expect(409))).toContain(NOT_ENROLLED_MESSAGE);
      expect(await auditOf('student.withdrawn')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------- move

  describe('moving a student to another cohort', () => {
    let otherCohortId: string;

    beforeEach(async () => {
      otherCohortId = await makeCohort(adminOne, courseId, { name: 'Cohort B' });
    });

    it('ends the old enrollment as TRANSFERRED and starts a new one, in one step', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');

      const res = await move(adminOne, ada.studentId, otherCohortId).expect(200);

      const history = res.body.student.enrollments;
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ status: 'ACTIVE', endedAt: null, cohort: { id: otherCohortId, name: 'Cohort B' } });
      expect(history[1]).toMatchObject({ status: 'TRANSFERRED', cohort: { id: cohortId } });
      expect(history[1].endedAt).toEqual(expect.any(String));

      const rows = await kit.prisma.enrollment.findMany({ where: { studentId: ada.studentId }, orderBy: { enrolledAt: 'asc' } });
      expect(rows[0]).toMatchObject({ cohortId, applicationId: ada.applicationId, status: 'TRANSFERRED' });
      expect(rows[1]).toMatchObject({ cohortId: otherCohortId, applicationId: null, status: 'ACTIVE', createdById: adminId });
    });

    it('moves her course access with her, and the seat counts follow', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      const session = await kit.loginAgent('ada@example.org', 'student');

      await move(adminOne, ada.studentId, otherCohortId).expect(200);

      const dashboard = await session.get(DASHBOARD).expect(200);
      expect(dashboard.body).toMatchObject({ courseAccess: 'unlocked', enrollment: { cohort: { id: otherCohortId } } });
      expect((await adminOne.get(`/api/v1/admin/cohorts/${cohortId}`).expect(200)).body.cohort.enrolledCount).toBe(0);
      expect((await adminOne.get(`/api/v1/admin/cohorts/${otherCohortId}`).expect(200)).body.cohort.enrolledCount).toBe(1);
    });

    it('is audited with both cohort ids', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      await move(adminOne, ada.studentId, otherCohortId).expect(200);

      const [audit] = await auditOf('student.moved');
      expect(audit).toMatchObject({
        actorId: adminId,
        entityId: ada.studentId,
        metadata: { fromCohortId: cohortId, toCohortId: otherCohortId },
      });
    });

    it('may move her into a cohort of a different course or track', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      const webTrack = await makeTrack(adminOne, 'Web Development');
      const webCourse = await makeCourse(adminOne, webTrack, 'Intro to Web');
      const webCohort = await makeCohort(adminOne, webCourse, { name: 'Web Cohort' });

      const res = await move(adminOne, ada.studentId, webCohort).expect(200);
      expect(res.body.student.enrollments[0]).toMatchObject({ status: 'ACTIVE', track: { id: webTrack } });
    });

    it('is refused when she is not enrolled, or is already in that cohort', async () => {
      const waiting = await applicant('Waiting Girl', 'waiting@example.org');
      expect(said(await move(adminOne, waiting.studentId, otherCohortId).expect(409))).toContain(NOT_ENROLLED_MESSAGE);

      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      expect(said(await move(adminOne, ada.studentId, cohortId).expect(409))).toContain('She is already in this cohort.');
    });

    it('answers 404 for an unknown cohort and 400 for a missing or malformed one', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');

      expect(said(await move(adminOne, ada.studentId, SOME_ID).expect(404))).toContain('Cohort not found.');
      await adminOne.post(`${STUDENTS}/${ada.studentId}/move`).send({}).expect(400);
      await move(adminOne, ada.studentId, 'nope').expect(400);
      await adminOne.post(`${STUDENTS}/${ada.studentId}/move`).send({ cohortId: otherCohortId, status: 'ACTIVE' }).expect(400);

      expect(await activeEnrollments(ada.studentId)).toMatchObject([{ cohortId }]); // nothing changed
    });

    it('is refused for an archived cohort and for a full one, leaving her where she was', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');

      await adminOne.post(`/api/v1/admin/cohorts/${otherCohortId}/archive`).expect(200);
      expect(said(await move(adminOne, ada.studentId, otherCohortId).expect(409))).toContain('archived cohort');

      const full = await makeCohort(adminOne, courseId, { name: 'Full Cohort', capacity: 1 });
      const bola = await applicant('Bola Adeyemi', 'bola@example.org');
      await adminOne.post(`${APPLICATIONS}/${bola.applicationId}/accept`).send({ cohortId: full }).expect(200);
      expect(said(await move(adminOne, ada.studentId, full).expect(409))).toContain('This cohort is full.');

      expect(await activeEnrollments(ada.studentId)).toMatchObject([{ cohortId }]);
      expect(await auditOf('student.moved')).toHaveLength(0);
    });

    it('is refused for a suspended student', async () => {
      const ada = await enrolled('Ada Okoye', 'ada@example.org');
      await suspend(adminOne, ada.studentId).expect(200);

      expect(said(await move(adminOne, ada.studentId, otherCohortId).expect(409))).toContain('suspended');
      expect(await activeEnrollments(ada.studentId)).toMatchObject([{ cohortId }]);
    });
  });

  // ----------------------------------------------------- two admins at once

  describe('two admins acting at the same moment', () => {
    it('give a one-seat cohort to only one of two students moved into it', async () => {
      const oneSeat = await makeCohort(adminOne, courseId, { name: 'One Seat', capacity: 1 });
      const [a, b] = [await enrolled('Girl One', 'one@example.org'), await enrolled('Girl Two', 'two@example.org')];

      const [first, second] = await Promise.all([move(adminOne, a.studentId, oneSeat), move(adminTwo, b.studentId, oneSeat)]);

      expect(statuses(first, second)).toEqual([200, 409]);
      expect(await kit.prisma.enrollment.count({ where: { cohortId: oneSeat, status: 'ACTIVE' } })).toBe(1);
      expect(await kit.prisma.enrollment.count({ where: { cohortId, status: 'ACTIVE' } })).toBe(1); // the loser stayed put
    });

    it('do not get stuck when two students are moved in opposite directions', async () => {
      const cohortB = await makeCohort(adminOne, courseId, { name: 'Cohort B' });
      const inA = await enrolled('In A', 'a@example.org', cohortId);
      const inB = await enrolled('In B', 'b@example.org', cohortB);

      const [first, second] = await Promise.all([move(adminOne, inA.studentId, cohortB), move(adminTwo, inB.studentId, cohortId)]);

      expect(statuses(first, second)).toEqual([200, 200]); // no deadlock, both moves happen
      expect(await activeEnrollments(inA.studentId)).toMatchObject([{ cohortId: cohortB }]);
      expect(await activeEnrollments(inB.studentId)).toMatchObject([{ cohortId }]);
    });

    it('cannot both take the last seat: a move against an acceptance', async () => {
      const oneSeat = await makeCohort(adminOne, courseId, { name: 'One Seat', capacity: 1 });
      const mover = await enrolled('Mover', 'mover@example.org');
      const waiting = await applicant('Waiting Girl', 'waiting@example.org');

      const [moving, accepting] = await Promise.all([
        move(adminOne, mover.studentId, oneSeat),
        adminTwo.post(`${APPLICATIONS}/${waiting.applicationId}/accept`).send({ cohortId: oneSeat }),
      ]);

      expect(statuses(moving, accepting)).toEqual([200, 409]);
      expect(await kit.prisma.enrollment.count({ where: { cohortId: oneSeat, status: 'ACTIVE' } })).toBe(1);
    });

    it('stay consistent when one admin withdraws her while another moves her', async () => {
      const cohortB = await makeCohort(adminOne, courseId, { name: 'Cohort B' });
      const ada = await enrolled('Ada Okoye', 'ada@example.org');

      const [withdrawing, moving] = await Promise.all([withdraw(adminOne, ada.studentId), move(adminTwo, ada.studentId, cohortB)]);

      expect(statuses(withdrawing, moving)).toEqual([200, 409]);

      const active = await activeEnrollments(ada.studentId);
      if (moving.status === 200) {
        expect(active).toMatchObject([{ cohortId: cohortB }]);
      } else {
        expect(active).toHaveLength(0);
      }
    });
  });
});