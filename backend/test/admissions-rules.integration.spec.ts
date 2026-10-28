/**
 * admissions-rules.integration.spec.ts
 * ---------------------------------------------------------------------------
 * The "real life" rules around admissions:
 *   - two admins acting at the SAME moment (the last seat, the same
 *     application, archiving a cohort while someone is being accepted);
 *   - a cohort with enrolled students cannot be archived;
 *   - the enrolled count only counts students who are still enrolled.
 *
 * Real app, PostgreSQL and Redis (the TEST ones).
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { EnrollmentStatus, Role } from '@prisma/client';

import { makeCohort, makeStack } from './helpers/catalog-helpers';
import { enroll, makeApplicant } from './helpers/student-helpers';
import { createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const APPLICATIONS = '/api/v1/admin/applications';
const COHORTS = '/api/v1/admin/cohorts';

const said = (res: { body: unknown }) => JSON.stringify(res.body);
const statuses = (...responses: Array<{ status: number }>) => responses.map((r) => r.status).sort((a, b) => a - b);

describe('Admissions: races and cohort rules (integration)', () => {
  let kit: TestKit;
  let adminOne: TestAgent;
  let adminTwo: TestAgent;
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
    await kit.createUser({ email: 'admin1@example.org', fullName: 'First Admin', role: Role.ADMIN });
    await kit.createUser({ email: 'admin2@example.org', fullName: 'Second Admin', role: Role.ADMIN });
    adminOne = await kit.loginAgent('admin1@example.org', 'admin');
    adminTwo = await kit.loginAgent('admin2@example.org', 'admin');
    ({ trackId, courseId, cohortId } = await makeStack(adminOne));
  });

  const girl = (n: number) => makeApplicant(kit, trackId, { fullName: `Girl ${n}`, email: `girl${n}@example.org` });

  const acceptAs = (who: TestAgent, applicationId: string, into: string) =>
    who.post(`${APPLICATIONS}/${applicationId}/accept`).send({ cohortId: into });

  const declineAs = (who: TestAgent, applicationId: string) =>
    who.post(`${APPLICATIONS}/${applicationId}/decline`).send({});

  const archiveAs = (who: TestAgent, id: string) => who.post(`${COHORTS}/${id}/archive`);

  const count = (template: string) => kit.prisma.emailOutbox.count({ where: { template } });

  // ------------------------------------------------- two admins at once

  describe('two admins acting at the same moment', () => {
    it('give the last seat to only one of two girls', async () => {
      const oneSeat = await makeCohort(adminOne, courseId, { name: 'One Seat', capacity: 1 });
      const [a, b] = await Promise.all([girl(1), girl(2)]);

      const [first, second] = await Promise.all([
        acceptAs(adminOne, a.applicationId, oneSeat),
        acceptAs(adminTwo, b.applicationId, oneSeat),
      ]);

      expect(statuses(first, second)).toEqual([200, 409]);
      expect(said(first.status === 409 ? first : second)).toContain('This cohort is full.');

      expect(await kit.prisma.enrollment.count({ where: { cohortId: oneSeat } })).toBe(1);
      expect(await kit.prisma.studentApplication.count({ where: { status: 'ACCEPTED' } })).toBe(1);
      expect(await kit.prisma.studentApplication.count({ where: { status: 'PENDING' } })).toBe(1);
      expect(await count('application-accepted')).toBe(1);
      expect(await kit.prisma.auditLog.count({ where: { action: 'application.accepted' } })).toBe(1);
    });

    it('never over-fill a cohort: four girls racing for two seats', async () => {
      const twoSeats = await makeCohort(adminOne, courseId, { name: 'Two Seats', capacity: 2 });
      const girls = await Promise.all([1, 2, 3, 4].map((n) => girl(n)));

      const responses = await Promise.all(
        girls.map((g, index) => acceptAs(index % 2 === 0 ? adminOne : adminTwo, g.applicationId, twoSeats)),
      );

      expect(statuses(...responses)).toEqual([200, 200, 409, 409]);
      expect(await kit.prisma.enrollment.count({ where: { cohortId: twoSeats } })).toBe(2);
      expect(await kit.prisma.studentApplication.count({ where: { status: 'ACCEPTED' } })).toBe(2);
      expect(await kit.prisma.studentApplication.count({ where: { status: 'PENDING' } })).toBe(2);
    });

    it('cannot both decide the same application: accept against decline', async () => {
      const applicant = await girl(1);

      const [accepting, declining] = await Promise.all([
        acceptAs(adminOne, applicant.applicationId, cohortId),
        declineAs(adminTwo, applicant.applicationId),
      ]);

      expect(statuses(accepting, declining)).toEqual([200, 409]);

      // Whoever won, the records agree with each other.
      const acceptedWon = accepting.status === 200;
      const final = await kit.prisma.studentApplication.findUniqueOrThrow({ where: { id: applicant.applicationId } });
      expect(final.status).toBe(acceptedWon ? 'ACCEPTED' : 'DECLINED');
      expect(await kit.prisma.enrollment.count()).toBe(acceptedWon ? 1 : 0);
      expect(await count('application-accepted')).toBe(acceptedWon ? 1 : 0);
      expect(await count('application-declined')).toBe(acceptedWon ? 0 : 1);
      expect(
        await kit.prisma.auditLog.count({ where: { action: { in: ['application.accepted', 'application.declined'] } } }),
      ).toBe(1);
    });

    it('cannot both accept the same application into two different cohorts', async () => {
      const applicant = await girl(1);
      const other = await makeCohort(adminOne, courseId, { name: 'Other Cohort' });

      const [first, second] = await Promise.all([
        acceptAs(adminOne, applicant.applicationId, cohortId),
        acceptAs(adminTwo, applicant.applicationId, other),
      ]);

      expect(statuses(first, second)).toEqual([200, 409]);
      expect(await kit.prisma.enrollment.count()).toBe(1);
      expect(await count('application-accepted')).toBe(1);
    });

    it('never end up with a student in an archived cohort: accepting against archiving', async () => {
      for (let round = 1; round <= 3; round += 1) {
        const target = await makeCohort(adminOne, courseId, { name: `Race Cohort ${round}` });
        const applicant = await girl(10 + round);

        const [accepting, archiving] = await Promise.all([
          acceptAs(adminOne, applicant.applicationId, target),
          archiveAs(adminTwo, target),
        ]);

        // Exactly one of them wins.
        expect(statuses(accepting, archiving)).toEqual([200, 409]);

        const cohort = await kit.prisma.cohort.findUniqueOrThrow({ where: { id: target } });
        const seated = await kit.prisma.enrollment.count({ where: { cohortId: target, status: 'ACTIVE' } });

        expect(cohort.status === 'ARCHIVED' && seated > 0).toBe(false); // never both
        if (accepting.status === 200) {
          expect(cohort.status).toBe('ACTIVE');
          expect(seated).toBe(1);
        } else {
          expect(cohort.status).toBe('ARCHIVED');
          expect(seated).toBe(0);
        }
      }
    });
  });

  // ------------------------------------------------- archiving a cohort

  describe('archiving a cohort that has students', () => {
    it('is refused while one girl is enrolled, and says how many', async () => {
      const applicant = await girl(1);
      await acceptAs(adminOne, applicant.applicationId, cohortId).expect(200);

      const res = await archiveAs(adminOne, cohortId).expect(409);

      expect(said(res)).toContain('This cohort still has 1 enrolled student. Move or withdraw her first.');
      expect((await kit.prisma.cohort.findUniqueOrThrow({ where: { id: cohortId } })).status).toBe('ACTIVE');
      expect(await kit.prisma.auditLog.count({ where: { action: 'cohort.archived' } })).toBe(0);
    });

    it('uses the plural when several are enrolled', async () => {
      const [a, b] = await Promise.all([girl(1), girl(2)]);
      await acceptAs(adminOne, a.applicationId, cohortId).expect(200);
      await acceptAs(adminOne, b.applicationId, cohortId).expect(200);

      const res = await archiveAs(adminOne, cohortId).expect(409);
      expect(said(res)).toContain('This cohort still has 2 enrolled students. Move or withdraw them first.');
    });

    it('is allowed once everyone has left, because ended enrollments do not count', async () => {
      const applicant = await girl(1);
      await acceptAs(adminOne, applicant.applicationId, cohortId).expect(200);
      await kit.prisma.enrollment.updateMany({
        where: { cohortId },
        data: { status: EnrollmentStatus.WITHDRAWN, endedAt: new Date() },
      });

      const res = await archiveAs(adminOne, cohortId).expect(200);

      expect(res.body.cohort).toMatchObject({ id: cohortId, status: 'ARCHIVED', enrolledCount: 0 });
      expect(await kit.prisma.auditLog.count({ where: { action: 'cohort.archived' } })).toBe(1);
    });

    it('still works as before for a cohort with no students', async () => {
      const empty = await makeCohort(adminOne, courseId, { name: 'Empty Cohort' });
      const res = await archiveAs(adminOne, empty).expect(200);
      expect(res.body.cohort).toMatchObject({ status: 'ARCHIVED', enrolledCount: 0 });
    });
  });

  // ------------------------------------------------- the enrolled count

  describe('the enrolled count', () => {
    it('counts only students who are still enrolled, on the detail page and in the list', async () => {
      const [a, b, c, d] = await Promise.all([girl(1), girl(2), girl(3), girl(4)]);
      await enroll(kit, a.studentId, cohortId);
      await enroll(kit, b.studentId, cohortId);
      await enroll(kit, c.studentId, cohortId, { status: EnrollmentStatus.WITHDRAWN });
      await enroll(kit, d.studentId, cohortId, { status: EnrollmentStatus.TRANSFERRED });

      const detail = await adminOne.get(`${COHORTS}/${cohortId}`).expect(200);
      expect(detail.body.cohort.enrolledCount).toBe(2);

      const list = await adminOne.get(COHORTS).expect(200);
      const row = list.body.items.find((item: { id: string }) => item.id === cohortId);
      expect(row.enrolledCount).toBe(2);
    });

    it('is zero for a cohort nobody has joined', async () => {
      const detail = await adminOne.get(`${COHORTS}/${cohortId}`).expect(200);
      expect(detail.body.cohort.enrolledCount).toBe(0);
    });
  });
});