/**
 * admin-students.integration.spec.ts
 * ---------------------------------------------------------------------------
 * What an ADMIN sees of students: a searchable, filterable list (small, no
 * private details) and a detail page (everything, admin-only).
 * Real app, PostgreSQL and Redis (the TEST ones).
 *
 * Changing students (edit, suspend, withdraw, move) is tested in
 * student-management.integration.spec.ts.
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { AccountStatus, EnrollmentStatus, Role } from '@prisma/client';
import request from 'supertest';

import { ageOnDate } from '../src/students/age';
import { dayOffset, makeCohort, makeCourse, makeStack, makeTrack } from './helpers/catalog-helpers';
import { enroll, makeApplicant } from './helpers/student-helpers';
import { createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const STUDENTS = '/api/v1/admin/students';
const APPLICATIONS = '/api/v1/admin/applications';
const SOME_ID = '11111111-1111-4111-8111-111111111111';

const said = (res: { body: unknown }) => JSON.stringify(res.body);

describe('Admin: students (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;
  let adminId: string;
  let teacherId: string;
  let trackId: string;
  let courseId: string;
  let cohortId: string;
  let webTrackId: string;
  let webCohortId: string;

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    adminId = (await kit.createUser({ email: 'admin@example.org', fullName: 'Pat Admin', role: Role.ADMIN })).id;
    teacherId = (await kit.createUser({ email: 'teacher@example.org', fullName: 'Tina Teacher', role: Role.INSTRUCTOR })).id;
    admin = await kit.loginAgent('admin@example.org', 'admin');
    ({ trackId, courseId, cohortId } = await makeStack(admin));

    webTrackId = await makeTrack(admin, 'Web Development');
    const webCourseId = await makeCourse(admin, webTrackId, 'Intro to Web');
    webCohortId = await makeCohort(admin, webCourseId, { name: 'Web Cohort' });
  });

  const accept = (applicationId: string, into: string = cohortId, note?: string) =>
    admin.post(`${APPLICATIONS}/${applicationId}/accept`).send({ cohortId: into, ...(note ? { note } : {}) });

  const names = (res: { body: { items: { fullName: string }[] } }) => res.body.items.map((item) => item.fullName);

  // ---------------------------------------------------------- who may use it

  it('refuses signed-out visitors (401), students (403) and instructors (403)', async () => {
    await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
    const student = await kit.loginAgent('student@example.org', 'student');
    const teacher = await kit.loginAgent('teacher@example.org', 'instructor');

    for (const path of [STUDENTS, `${STUDENTS}/${SOME_ID}`]) {
      await request(kit.server()).get(path).expect(401);
      await student.get(path).expect(403);
      await teacher.get(path).expect(403);
    }
  });

  // -------------------------------------------------------------------- list

  describe('the student list', () => {
    let ada: Awaited<ReturnType<typeof makeApplicant>>;
    let bola: Awaited<ReturnType<typeof makeApplicant>>;
    let chidinma: Awaited<ReturnType<typeof makeApplicant>>;
    let dayo: Awaited<ReturnType<typeof makeApplicant>>;
    let eke: Awaited<ReturnType<typeof makeApplicant>>;

    beforeEach(async () => {
      ada = await makeApplicant(kit, trackId, { fullName: 'Ada Okoye', email: 'ada@example.org', createdAt: new Date('2026-10-01T09:00:00Z') });
      bola = await makeApplicant(kit, trackId, { fullName: 'Bola Adeyemi', email: 'bola@example.org', createdAt: new Date('2026-10-02T09:00:00Z') });
      chidinma = await makeApplicant(kit, trackId, { fullName: 'Chidinma Eze', email: 'chidi@example.org', createdAt: new Date('2026-10-03T09:00:00Z') });
      dayo = await makeApplicant(kit, webTrackId, { fullName: 'Dayo Bello', email: 'dayo@example.org', createdAt: new Date('2026-10-04T09:00:00Z') });
      eke = await makeApplicant(kit, trackId, { fullName: 'Eke Obi', email: 'eke@example.org', createdAt: new Date('2026-10-05T09:00:00Z') });

      await accept(ada.applicationId, cohortId).expect(200);
      await accept(dayo.applicationId, webCohortId).expect(200);
      await admin.post(`${APPLICATIONS}/${bola.applicationId}/decline`).send({}).expect(200);
      await kit.prisma.user.update({ where: { id: eke.studentId }, data: { status: AccountStatus.SUSPENDED } });
    });

    it('lists only students (never admins or instructors), newest account first', async () => {
      const res = await admin.get(STUDENTS).expect(200);

      expect(names(res)).toEqual(['Eke Obi', 'Dayo Bello', 'Chidinma Eze', 'Bola Adeyemi', 'Ada Okoye']);
      expect(res.body).toMatchObject({ total: 5, page: 1, totalPages: 1 });
      expect(said(res)).not.toContain('Pat Admin');
      expect(said(res)).not.toContain('Tina Teacher');
    });

    it('shows a small summary of each: application, current cohort and account status', async () => {
      const res = await admin.get(`${STUDENTS}?sortBy=name&sortDir=asc`).expect(200);
      const [first, second, , , last] = res.body.items;

      expect(first).toMatchObject({
        id: ada.studentId,
        fullName: 'Ada Okoye',
        email: 'ada@example.org',
        emailVerified: false,
        accountStatus: 'ACTIVE',
        application: { id: ada.applicationId, status: 'ACCEPTED' },
        enrollment: { cohortId, cohortName: 'Cohort 1', courseTitle: 'Intro to AI', trackName: 'AI & Robotics' },
      });
      expect(second).toMatchObject({ fullName: 'Bola Adeyemi', application: { status: 'DECLINED' }, enrollment: null });
      expect(last).toMatchObject({ fullName: 'Eke Obi', accountStatus: 'SUSPENDED' });
    });

    it('keeps private details out of the list', async () => {
      const body = said(await admin.get(STUDENTS).expect(200));
      for (const hidden of [
        '08012345678',
        '2000-05-05',
        'Government College',
        'Lagos',
        'Built a small robot',
        'I love building',
        'guardian',
        'decisionNote',
      ]) {
        expect(body).not.toContain(hidden);
      }
    });

    it('filters by account status and by application status', async () => {
      expect(names(await admin.get(`${STUDENTS}?accountStatus=SUSPENDED`).expect(200))).toEqual(['Eke Obi']);
      expect((await admin.get(`${STUDENTS}?accountStatus=ACTIVE`).expect(200)).body.total).toBe(4);

      const accepted = await admin.get(`${STUDENTS}?applicationStatus=ACCEPTED&sortBy=name&sortDir=asc`).expect(200);
      expect(names(accepted)).toEqual(['Ada Okoye', 'Dayo Bello']);
      expect(names(await admin.get(`${STUDENTS}?applicationStatus=DECLINED`).expect(200))).toEqual(['Bola Adeyemi']);
      expect(names(await admin.get(`${STUDENTS}?applicationStatus=PENDING&sortBy=name&sortDir=asc`).expect(200))).toEqual([
        'Chidinma Eze',
        'Eke Obi',
      ]);
    });

    it('filters by the track or cohort she is in now', async () => {
      expect(names(await admin.get(`${STUDENTS}?trackId=${trackId}`).expect(200))).toEqual(['Ada Okoye']);
      expect(names(await admin.get(`${STUDENTS}?trackId=${webTrackId}`).expect(200))).toEqual(['Dayo Bello']);
      expect(names(await admin.get(`${STUDENTS}?cohortId=${cohortId}`).expect(200))).toEqual(['Ada Okoye']);
      expect(names(await admin.get(`${STUDENTS}?cohortId=${webCohortId}`).expect(200))).toEqual(['Dayo Bello']);
    });

    it('looks only at her CURRENT enrollment, so a girl who left no longer matches', async () => {
      await kit.prisma.enrollment.updateMany({
        where: { studentId: ada.studentId },
        data: { status: EnrollmentStatus.WITHDRAWN, endedAt: new Date() },
      });

      expect(names(await admin.get(`${STUDENTS}?cohortId=${cohortId}`).expect(200))).toEqual([]);
      expect(names(await admin.get(`${STUDENTS}?trackId=${trackId}`).expect(200))).toEqual([]);

      const res = await admin.get(`${STUDENTS}?sortBy=name&sortDir=asc`).expect(200);
      expect(res.body.items[0]).toMatchObject({ fullName: 'Ada Okoye', enrollment: null });
    });

    it('searches names and emails, ignoring capitals', async () => {
      expect(names(await admin.get(`${STUDENTS}?search=ADA`).expect(200))).toEqual(['Ada Okoye']);
      expect(names(await admin.get(`${STUDENTS}?search=dayo`).expect(200))).toEqual(['Dayo Bello']);
      expect(names(await admin.get(`${STUDENTS}?search=EKE@EXAMPLE`).expect(200))).toEqual(['Eke Obi']);
      expect(names(await admin.get(`${STUDENTS}?search=nobody-here`).expect(200))).toEqual([]);
    });

    it('sorts by name or by when the account was made, either way', async () => {
      expect(names(await admin.get(`${STUDENTS}?sortBy=name&sortDir=asc`).expect(200))).toEqual([
        'Ada Okoye',
        'Bola Adeyemi',
        'Chidinma Eze',
        'Dayo Bello',
        'Eke Obi',
      ]);
      expect(names(await admin.get(`${STUDENTS}?sortBy=name&sortDir=desc`).expect(200))[0]).toBe('Eke Obi');
      expect(names(await admin.get(`${STUDENTS}?sortBy=createdAt&sortDir=asc`).expect(200))[0]).toBe('Ada Okoye');
    });

    it('pages the results', async () => {
      const third = await admin.get(`${STUDENTS}?pageSize=2&page=3`).expect(200);
      expect(names(third)).toEqual(['Ada Okoye']);
      expect(third.body).toMatchObject({ total: 5, totalPages: 3, page: 3, pageSize: 2 });
    });

    it('rejects nonsense filters', async () => {
      for (const query of [
        'accountStatus=DELETED',
        'applicationStatus=MAYBE',
        'trackId=nope',
        'cohortId=nope',
        'sortBy=password',
        'sortDir=sideways',
        'pageSize=0',
        'pageSize=1000',
      ]) {
        await admin.get(`${STUDENTS}?${query}`).expect(400);
      }
    });

    it('cannot create or delete students: they join by applying, and nothing is ever deleted', async () => {
      await admin.post(STUDENTS).send({ fullName: 'New Girl' }).expect(404);
      await admin.delete(`${STUDENTS}/${ada.studentId}`).expect(404);
      expect(await kit.prisma.user.count({ where: { id: ada.studentId } })).toBe(1);
      expect(await kit.prisma.user.count({ where: { role: Role.STUDENT } })).toBe(5);
    });

    describe('one student', () => {
      it('shows her profile, application, the review and her enrollment', async () => {
        // Give this one a private note (the shared set-up accepts without one).
        const noted = await makeApplicant(kit, trackId, { fullName: 'Noted Girl', email: 'noted@example.org' });
        await accept(noted.applicationId, cohortId, 'Strong application').expect(200);

        const res = await admin.get(`${STUDENTS}/${noted.studentId}`).expect(200);

        expect(res.body.student).toMatchObject({
          id: noted.studentId,
          fullName: 'Noted Girl',
          email: 'noted@example.org',
          emailVerified: false,
          accountStatus: 'ACTIVE',
          lastLoginAt: null,
          profile: {
            dateOfBirth: '2000-05-05',
            age: ageOnDate('2000-05-05', dayOffset(0)),
            phone: '08012345678',
            location: 'Lagos',
            schoolName: 'Government College',
            gradeLevel: 'SS2',
            guardian: null,
          },
          application: {
            id: noted.applicationId,
            status: 'ACCEPTED',
            preferredTrack: { id: trackId, name: 'AI & Robotics' },
            answers: {
              whyJoin: 'I love building things with code.',
              hopeToLearn: 'How robots and AI really work.',
              stemExperience: 'Built a small robot.',
            },
            consent: { version: 'v1', guardianConsentAt: null },
            review: { reviewedBy: { id: adminId, fullName: 'Pat Admin' }, note: 'Strong application' },
          },
        });
        expect(res.body.student.enrollments).toHaveLength(1);
        expect(res.body.student.enrollments[0]).toMatchObject({
          status: 'ACTIVE',
          endedAt: null,
          cohort: { id: cohortId, name: 'Cohort 1' },
          course: { id: courseId, title: 'Intro to AI' },
          track: { id: trackId, name: 'AI & Robotics' },
        });
      });

      it('shows a guardian when one was given', async () => {
        const minor = await makeApplicant(kit, trackId, { fullName: 'Young Girl', email: 'young@example.org', withGuardian: true });
        const res = await admin.get(`${STUDENTS}/${minor.studentId}`).expect(200);
        expect(res.body.student.profile.guardian).toEqual({
          name: 'Mrs Okoye',
          email: 'mum@example.org',
          phone: '08098765432',
        });
      });

      it('keeps her earlier enrollments in the history, newest first', async () => {
        // Dayo is enrolled in the web cohort now; she was earlier in the AI cohort.
        await enroll(kit, dayo.studentId, cohortId, {
          status: EnrollmentStatus.TRANSFERRED,
          enrolledAt: new Date('2026-01-10T09:00:00Z'),
          endedAt: new Date('2026-02-10T09:00:00Z'),
        });

        const res = await admin.get(`${STUDENTS}/${dayo.studentId}`).expect(200);
        const history = res.body.student.enrollments;

        expect(history).toHaveLength(2);
        expect(history[0]).toMatchObject({ status: 'ACTIVE', cohort: { id: webCohortId }, track: { id: webTrackId } });
        expect(history[1]).toMatchObject({ status: 'TRANSFERRED', cohort: { id: cohortId }, track: { id: trackId } });
        expect(history[1].endedAt).toEqual(expect.any(String));
      });

      it('copes with a student who has no profile and no application yet', async () => {
        const bare = await kit.createUser({ email: 'bare@example.org', fullName: 'Bare Account', role: Role.STUDENT });

        const res = await admin.get(`${STUDENTS}/${bare.id}`).expect(200);
        expect(res.body.student).toMatchObject({ fullName: 'Bare Account', profile: null, application: null, enrollments: [] });
      });

      it('answers 404 for an admin, an instructor or an unknown id, and 400 for a malformed id', async () => {
        await admin.get(`${STUDENTS}/${adminId}`).expect(404);
        await admin.get(`${STUDENTS}/${teacherId}`).expect(404);
        await admin.get(`${STUDENTS}/${SOME_ID}`).expect(404);
        await admin.get(`${STUDENTS}/not-an-id`).expect(400);
      });

      it('never includes the password hash', async () => {
        const res = await admin.get(`${STUDENTS}/${ada.studentId}`).expect(200);
        expect(said(res)).not.toContain('passwordHash');
      });
    });
  });
});