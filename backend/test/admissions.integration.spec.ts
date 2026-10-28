/**
 * admissions.integration.spec.ts
 * ---------------------------------------------------------------------------
 * How an ADMIN reviews student applications: the review queue (search,
 * filters, pages), the detail page, and the three decisions - accept, decline
 * and reopen. Real app, PostgreSQL and Redis (the TEST ones).
 *
 * Applicants are created straight in the database (signup itself is covered
 * by students-signup.integration.spec.ts); every decision goes through the
 * REAL admin routes.
 *
 * Not in this file (next batch): two admins racing for the last seat, the
 * cohort-archive refusal, the admin student list and the instructor's view.
 *
 * Run with:  npm run test:db
 */
import { TEST_APP_ORIGIN } from './helpers/integration-env'; // must stay first: sets the environment

import { AccountStatus, Role } from '@prisma/client';
import request from 'supertest';

import { OutboxService } from '../src/common/outbox/outbox.service';
import { ageOnDate } from '../src/students/age';
import { DASHBOARD_MESSAGES } from '../src/students/students.constants';
import { dayOffset, makeCohort, makeStack, makeTrack } from './helpers/catalog-helpers';
import { createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const APPLICATIONS = '/api/v1/admin/applications';
const DASHBOARD = '/api/v1/students/me/dashboard';
const SOME_ID = '11111111-1111-4111-8111-111111111111';

const ALREADY_DECIDED = 'This application has already been decided.';

const said = (res: { body: unknown }) => JSON.stringify(res.body);

describe('Admissions: reviewing applications (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;
  let adminId: string;
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
    adminId = (await kit.createUser({ email: 'admin@example.org', fullName: 'Ada Admin', role: Role.ADMIN })).id;
    admin = await kit.loginAgent('admin@example.org', 'admin');
    ({ trackId, courseId, cohortId } = await makeStack(admin));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ----------------------------------------------------------------- helpers

  /** A student with a profile and a PENDING application, created directly in the database. */
  const makeApplicant = async (
    fullName = 'Ada Okoye',
    email = 'ada@example.org',
    over: Partial<{ submittedAt: Date; preferredTrackId: string; withGuardian: boolean }> = {},
  ) => {
    const user = await kit.prisma.user.create({
      data: {
        email,
        fullName,
        role: Role.STUDENT,
        status: AccountStatus.ACTIVE,
        passwordHash: kit.goodHash,
        studentProfile: {
          create: {
            dateOfBirth: new Date('2000-05-05'),
            phone: '08012345678',
            location: 'Lagos',
            schoolName: 'Government College',
            gradeLevel: 'SS2',
            ...(over.withGuardian
              ? { guardianName: 'Mrs Okoye', guardianEmail: 'mum@example.org', guardianPhone: '08098765432' }
              : {}),
          },
        },
        studentApplication: {
          create: {
            preferredTrackId: over.preferredTrackId ?? trackId,
            whyJoin: 'I love building things with code.',
            hopeToLearn: 'How robots and AI really work.',
            stemExperience: 'Built a small robot.',
            consentAcceptedAt: new Date(),
            consentVersion: 'v1',
            ...(over.submittedAt ? { submittedAt: over.submittedAt } : {}),
          },
        },
      },
      include: { studentApplication: true },
    });
    return { studentId: user.id, applicationId: user.studentApplication!.id, email };
  };

  const accept = (applicationId: string, into: string = cohortId, note?: string) =>
    admin.post(`${APPLICATIONS}/${applicationId}/accept`).send({ cohortId: into, ...(note ? { note } : {}) });

  const decline = (applicationId: string, note?: string) =>
    admin.post(`${APPLICATIONS}/${applicationId}/decline`).send(note ? { note } : {});

  const reopen = (applicationId: string) => admin.post(`${APPLICATIONS}/${applicationId}/reopen`);

  const names = (res: { body: { items: { student: { fullName: string } }[] } }) =>
    res.body.items.map((item) => item.student.fullName);

  const applicationState = (id: string) => kit.prisma.studentApplication.findUniqueOrThrow({ where: { id } });

  // ------------------------------------------------------ who may use these routes

  it('refuses signed-out visitors (401), students (403) and instructors (403) on every route', async () => {
    await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
    await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
    const student = await kit.loginAgent('student@example.org', 'student');
    const teacher = await kit.loginAgent('teacher@example.org', 'instructor');

    const routes: Array<['get' | 'post', string]> = [
      ['get', APPLICATIONS],
      ['get', `${APPLICATIONS}/${SOME_ID}`],
      ['post', `${APPLICATIONS}/${SOME_ID}/accept`],
      ['post', `${APPLICATIONS}/${SOME_ID}/decline`],
      ['post', `${APPLICATIONS}/${SOME_ID}/reopen`],
    ];

    for (const [method, path] of routes) {
      await request(kit.server())[method](path).expect(401);
      await student[method](path).expect(403);
      await teacher[method](path).expect(403);
    }
  });

  // -------------------------------------------------------------------- list

  describe('the review queue', () => {
    let webTrackId: string;
    let ada: Awaited<ReturnType<typeof makeApplicant>>;
    let bola: Awaited<ReturnType<typeof makeApplicant>>;
    let chidinma: Awaited<ReturnType<typeof makeApplicant>>;

    beforeEach(async () => {
      webTrackId = await makeTrack(admin, 'Web Development');
      ada = await makeApplicant('Ada Okoye', 'ada@example.org', { submittedAt: new Date('2026-10-01T09:00:00Z') });
      bola = await makeApplicant('Bola Adeyemi', 'bola@example.org', {
        submittedAt: new Date('2026-10-10T09:00:00Z'),
        preferredTrackId: webTrackId,
      });
      chidinma = await makeApplicant('Chidinma Eze', 'chidi@example.org', { submittedAt: new Date('2026-10-20T09:00:00Z') });
    });

    it('shows the newest application first, with a small summary of each', async () => {
      await kit.prisma.user.update({ where: { id: ada.studentId }, data: { emailVerifiedAt: new Date() } });

      const res = await admin.get(APPLICATIONS).expect(200);

      expect(names(res)).toEqual(['Chidinma Eze', 'Bola Adeyemi', 'Ada Okoye']);
      expect(res.body).toMatchObject({ total: 3, page: 1, totalPages: 1 });
      expect(res.body.items[2]).toMatchObject({
        id: ada.applicationId,
        status: 'PENDING',
        reviewedAt: null,
        student: { id: ada.studentId, fullName: 'Ada Okoye', email: 'ada@example.org', emailVerified: true, accountStatus: 'ACTIVE' },
        preferredTrack: { id: trackId, name: 'AI & Robotics' },
      });
      expect(res.body.items[1].student.emailVerified).toBe(false);
    });

    it('keeps private details out of the list', async () => {
      const body = said(await admin.get(APPLICATIONS).expect(200));
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

    it('filters by status', async () => {
      await accept(chidinma.applicationId).expect(200);
      await decline(bola.applicationId).expect(200);

      expect(names(await admin.get(`${APPLICATIONS}?status=PENDING`).expect(200))).toEqual(['Ada Okoye']);
      expect(names(await admin.get(`${APPLICATIONS}?status=ACCEPTED`).expect(200))).toEqual(['Chidinma Eze']);
      expect(names(await admin.get(`${APPLICATIONS}?status=DECLINED`).expect(200))).toEqual(['Bola Adeyemi']);
    });

    it('filters by preferred track', async () => {
      expect(names(await admin.get(`${APPLICATIONS}?preferredTrackId=${webTrackId}`).expect(200))).toEqual(['Bola Adeyemi']);
      expect((await admin.get(`${APPLICATIONS}?preferredTrackId=${trackId}`).expect(200)).body.total).toBe(2);
    });

    it('searches names and emails, ignoring capitals', async () => {
      expect(names(await admin.get(`${APPLICATIONS}?search=ADA`).expect(200))).toEqual(['Ada Okoye']);
      expect(names(await admin.get(`${APPLICATIONS}?search=chidi`).expect(200))).toEqual(['Chidinma Eze']);
      expect(names(await admin.get(`${APPLICATIONS}?search=CHIDI`).expect(200))).toEqual(['Chidinma Eze']);
      expect(names(await admin.get(`${APPLICATIONS}?search=nobody-here`).expect(200))).toEqual([]);
    });

    it('filters by the date submitted', async () => {
      expect(names(await admin.get(`${APPLICATIONS}?from=2026-10-05`).expect(200))).toEqual(['Chidinma Eze', 'Bola Adeyemi']);
      expect(names(await admin.get(`${APPLICATIONS}?to=2026-10-15`).expect(200))).toEqual(['Bola Adeyemi', 'Ada Okoye']);
      expect(names(await admin.get(`${APPLICATIONS}?from=2026-10-05&to=2026-10-15`).expect(200))).toEqual(['Bola Adeyemi']);
    });

    it('sorts by name and by date, either way', async () => {
      expect(names(await admin.get(`${APPLICATIONS}?sortBy=name&sortDir=asc`).expect(200))).toEqual([
        'Ada Okoye',
        'Bola Adeyemi',
        'Chidinma Eze',
      ]);
      expect(names(await admin.get(`${APPLICATIONS}?sortBy=submittedAt&sortDir=asc`).expect(200))).toEqual([
        'Ada Okoye',
        'Bola Adeyemi',
        'Chidinma Eze',
      ]);
    });

    it('pages the results', async () => {
      const second = await admin.get(`${APPLICATIONS}?pageSize=2&page=2`).expect(200);
      expect(names(second)).toEqual(['Ada Okoye']);
      expect(second.body).toMatchObject({ total: 3, totalPages: 2, page: 2, pageSize: 2 });
    });

    it('rejects nonsense filters', async () => {
      for (const query of ['status=MAYBE', 'sortBy=password', 'sortDir=sideways', 'preferredTrackId=nope', 'from=not-a-date', 'pageSize=1000']) {
        await admin.get(`${APPLICATIONS}?${query}`).expect(400);
      }
    });
  });

  // ------------------------------------------------------------------ detail

  describe('one application', () => {
    it('shows everything the student submitted, including her age and guardian', async () => {
      const applicant = await makeApplicant('Ada Okoye', 'ada@example.org', { withGuardian: true });

      const res = await admin.get(`${APPLICATIONS}/${applicant.applicationId}`).expect(200);

      expect(res.body.application).toMatchObject({
        id: applicant.applicationId,
        status: 'PENDING',
        student: { id: applicant.studentId, fullName: 'Ada Okoye', email: 'ada@example.org', emailVerified: false, accountStatus: 'ACTIVE' },
        preferredTrack: { id: trackId, name: 'AI & Robotics' },
        profile: {
          dateOfBirth: '2000-05-05',
          age: ageOnDate('2000-05-05', dayOffset(0)),
          phone: '08012345678',
          location: 'Lagos',
          schoolName: 'Government College',
          gradeLevel: 'SS2',
          guardian: { name: 'Mrs Okoye', email: 'mum@example.org', phone: '08098765432' },
        },
        answers: {
          whyJoin: 'I love building things with code.',
          hopeToLearn: 'How robots and AI really work.',
          stemExperience: 'Built a small robot.',
        },
        consent: { version: 'v1', guardianConsentAt: null },
        review: null,
        enrollment: null,
      });
      expect(res.body.application.consent.acceptedAt).toEqual(expect.any(String));
    });

    it('shows no guardian when none was given', async () => {
      const applicant = await makeApplicant();
      const res = await admin.get(`${APPLICATIONS}/${applicant.applicationId}`).expect(200);
      expect(res.body.application.profile.guardian).toBeNull();
    });

    it('answers 404 for an unknown application and 400 for something that is not an id', async () => {
      await admin.get(`${APPLICATIONS}/${SOME_ID}`).expect(404);
      await admin.get(`${APPLICATIONS}/not-an-id`).expect(400);
    });
  });

  // ------------------------------------------------------------------ accept

  describe('accepting', () => {
    it('records the decision, creates the enrollment, queues the email and writes the audit entry', async () => {
      const applicant = await makeApplicant();

      const res = await accept(applicant.applicationId, cohortId, 'Strong application').expect(200);

      expect(res.body.application).toMatchObject({ id: applicant.applicationId, status: 'ACCEPTED' });
      expect(res.body.enrollment).toMatchObject({ cohort: { id: cohortId, name: 'Cohort 1', enrolledCount: 1 } });

      const decided = await applicationState(applicant.applicationId);
      expect(decided).toMatchObject({ status: 'ACCEPTED', reviewedById: adminId, decisionNote: 'Strong application' });
      expect(decided.reviewedAt).toBeInstanceOf(Date);

      const enrollments = await kit.prisma.enrollment.findMany();
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0]).toMatchObject({
        studentId: applicant.studentId,
        cohortId,
        applicationId: applicant.applicationId,
        status: 'ACTIVE',
        endedAt: null,
        createdById: adminId,
      });

      const emails = await kit.prisma.emailOutbox.findMany({ where: { template: 'application-accepted' } });
      expect(emails).toHaveLength(1);
      expect(emails[0].toEmail).toBe('ada@example.org');
      expect(emails[0].payload).toEqual({
        fullName: 'Ada Okoye',
        trackName: 'AI & Robotics',
        courseTitle: 'Intro to AI',
        cohortName: 'Cohort 1',
        startsOn: dayOffset(7),
        endsOn: dayOffset(90),
        actionUrl: `${TEST_APP_ORIGIN}/login`,
      });

      const audits = await kit.prisma.auditLog.findMany({ where: { action: 'application.accepted' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorId: adminId,
        entityType: 'student_application',
        entityId: applicant.applicationId,
        metadata: { studentId: applicant.studentId, cohortId, courseId, trackId },
      });
    });

    it('unlocks her course, and she never sees the private note', async () => {
      const applicant = await makeApplicant();
      const student = await kit.loginAgent(applicant.email, 'student');
      expect((await student.get(DASHBOARD).expect(200)).body.courseAccess).toBe('locked');

      await accept(applicant.applicationId, cohortId, 'Strong application').expect(200);

      const dashboard = await student.get(DASHBOARD).expect(200);
      expect(dashboard.body).toMatchObject({
        application: { status: 'ACCEPTED' },
        enrollment: { cohort: { id: cohortId, name: 'Cohort 1', status: 'ACTIVE' } },
        courseAccess: 'unlocked',
        message: DASHBOARD_MESSAGES.accepted,
      });
      expect(dashboard.body.application.decidedAt).toEqual(expect.any(String));
      expect(said(dashboard)).not.toContain('Strong application');
      expect(said(dashboard)).not.toContain('decisionNote');
    });

    it('shows the reviewer, the note and the enrollment on the admin detail page', async () => {
      const applicant = await makeApplicant();
      await accept(applicant.applicationId, cohortId, 'Strong application').expect(200);

      const res = await admin.get(`${APPLICATIONS}/${applicant.applicationId}`).expect(200);
      expect(res.body.application).toMatchObject({
        status: 'ACCEPTED',
        review: { reviewedBy: { id: adminId, fullName: 'Ada Admin' }, note: 'Strong application' },
        enrollment: { status: 'ACTIVE', cohort: { id: cohortId } },
      });
    });

    it('works without a note', async () => {
      const applicant = await makeApplicant();
      await accept(applicant.applicationId).expect(200);
      expect((await applicationState(applicant.applicationId)).decisionNote).toBeNull();
    });

    it('can be done only once', async () => {
      const applicant = await makeApplicant();
      const secondCohort = await makeCohort(admin, courseId, { name: 'Cohort 2' });
      await accept(applicant.applicationId).expect(200);

      const again = await accept(applicant.applicationId).expect(409);
      expect(said(again)).toContain(ALREADY_DECIDED);
      await accept(applicant.applicationId, secondCohort).expect(409);

      expect(await kit.prisma.enrollment.count()).toBe(1);
      expect(await kit.prisma.emailOutbox.count({ where: { template: 'application-accepted' } })).toBe(1);
    });

    it('answers 404 for an unknown application or cohort, and 400 for a missing or malformed cohort', async () => {
      const applicant = await makeApplicant();

      await accept(SOME_ID).expect(404);
      const noCohort = await accept(applicant.applicationId, SOME_ID).expect(404);
      expect(said(noCohort)).toContain('Cohort not found.');

      await admin.post(`${APPLICATIONS}/${applicant.applicationId}/accept`).send({}).expect(400);
      await admin.post(`${APPLICATIONS}/${applicant.applicationId}/accept`).send({ cohortId: 'nope' }).expect(400);
      await admin
        .post(`${APPLICATIONS}/${applicant.applicationId}/accept`)
        .send({ cohortId, note: 'x'.repeat(1001) })
        .expect(400);
      await admin
        .post(`${APPLICATIONS}/${applicant.applicationId}/accept`)
        .send({ cohortId, status: 'ACCEPTED' }) // cannot sneak in extra fields
        .expect(400);

      expect((await applicationState(applicant.applicationId)).status).toBe('PENDING');
      expect(await kit.prisma.enrollment.count()).toBe(0);
    });

    it('refuses an archived cohort', async () => {
      const applicant = await makeApplicant();
      await admin.post(`/api/v1/admin/cohorts/${cohortId}/archive`).expect(200);

      const res = await accept(applicant.applicationId).expect(409);
      expect(said(res)).toContain('Students cannot be accepted into an archived cohort.');
      expect((await applicationState(applicant.applicationId)).status).toBe('PENDING');
    });

    it('refuses a full cohort, and leaves the next applicant waiting', async () => {
      const small = await makeCohort(admin, courseId, { name: 'Small Cohort', capacity: 1 });
      const first = await makeApplicant('First Girl', 'first@example.org');
      const second = await makeApplicant('Second Girl', 'second@example.org');

      await accept(first.applicationId, small).expect(200);
      const res = await accept(second.applicationId, small).expect(409);

      expect(said(res)).toContain('This cohort is full.');
      expect((await applicationState(second.applicationId)).status).toBe('PENDING');
      expect(await kit.prisma.enrollment.count({ where: { cohortId: small } })).toBe(1);
      expect((await admin.get(`/api/v1/admin/cohorts/${small}`).expect(200)).body.cohort.enrolledCount).toBe(1);
    });

    it('refuses a suspended student', async () => {
      const applicant = await makeApplicant();
      await kit.prisma.user.update({ where: { id: applicant.studentId }, data: { status: AccountStatus.SUSPENDED } });

      const res = await accept(applicant.applicationId).expect(409);
      expect(said(res)).toContain('suspended');
      expect((await applicationState(applicant.applicationId)).status).toBe('PENDING');
      expect(await kit.prisma.enrollment.count()).toBe(0);
    });

    it('refuses a student who is already enrolled in another cohort, and changes nothing', async () => {
      const applicant = await makeApplicant();
      const otherCohort = await makeCohort(admin, courseId, { name: 'Other Cohort' });
      await kit.prisma.enrollment.create({ data: { studentId: applicant.studentId, cohortId: otherCohort } });

      const res = await accept(applicant.applicationId).expect(409);

      expect(said(res)).toContain('already enrolled');
      expect((await applicationState(applicant.applicationId)).status).toBe('PENDING');
      expect(await kit.prisma.enrollment.count({ where: { studentId: applicant.studentId } })).toBe(1);
      expect(await kit.prisma.emailOutbox.count({ where: { template: 'application-accepted' } })).toBe(0);
      expect(await kit.prisma.auditLog.count({ where: { action: 'application.accepted' } })).toBe(0);
    });

    it('is all-or-nothing: if the email cannot be queued, no decision, seat or audit entry is left behind', async () => {
      const applicant = await makeApplicant();
      jest.spyOn(kit.app.get(OutboxService), 'enqueue').mockRejectedValueOnce(new Error('simulated failure'));

      const res = await accept(applicant.applicationId, cohortId, 'Strong application').expect(500);

      expect(said(res)).not.toContain('simulated'); // internal details never leak
      expect(await applicationState(applicant.applicationId)).toMatchObject({
        status: 'PENDING',
        reviewedAt: null,
        reviewedById: null,
        decisionNote: null,
      });
      expect(await kit.prisma.enrollment.count()).toBe(0);
      expect(await kit.prisma.emailOutbox.count({ where: { template: 'application-accepted' } })).toBe(0);
      expect(await kit.prisma.auditLog.count({ where: { action: 'application.accepted' } })).toBe(0);

      await accept(applicant.applicationId, cohortId, 'Strong application').expect(200); // and a retry works
    });
  });

  // ----------------------------------------------------------------- decline

  describe('declining', () => {
    it('records the decision with a private note, emails her without any reason, and audits it', async () => {
      const applicant = await makeApplicant();

      const res = await decline(applicant.applicationId, 'Outside our age range').expect(200);
      expect(res.body.application).toMatchObject({ id: applicant.applicationId, status: 'DECLINED' });

      const decided = await applicationState(applicant.applicationId);
      expect(decided).toMatchObject({ status: 'DECLINED', reviewedById: adminId, decisionNote: 'Outside our age range' });
      expect(decided.reviewedAt).toBeInstanceOf(Date);
      expect(await kit.prisma.enrollment.count()).toBe(0);

      const emails = await kit.prisma.emailOutbox.findMany({ where: { template: 'application-declined' } });
      expect(emails).toHaveLength(1);
      expect(emails[0].toEmail).toBe('ada@example.org');
      expect(emails[0].payload).toEqual({ fullName: 'Ada Okoye' }); // no reason, no note

      const audits = await kit.prisma.auditLog.findMany({ where: { action: 'application.declined' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorId: adminId,
        entityId: applicant.applicationId,
        metadata: { studentId: applicant.studentId },
      });
    });

    it('keeps her course locked and never shows her the note', async () => {
      const applicant = await makeApplicant();
      const student = await kit.loginAgent(applicant.email, 'student');
      await decline(applicant.applicationId, 'Outside our age range').expect(200);

      const dashboard = await student.get(DASHBOARD).expect(200);
      expect(dashboard.body).toMatchObject({
        application: { status: 'DECLINED' },
        enrollment: null,
        courseAccess: 'locked',
        message: DASHBOARD_MESSAGES.declined,
      });
      expect(said(dashboard)).not.toContain('Outside our age range');
      expect(said(dashboard)).not.toContain('decisionNote');
    });

    it('works without a note', async () => {
      const applicant = await makeApplicant();
      await decline(applicant.applicationId).expect(200);
      expect((await applicationState(applicant.applicationId)).decisionNote).toBeNull();
    });

    it('cannot be done to an application that is already decided', async () => {
      const declined = await makeApplicant('Declined Girl', 'declined@example.org');
      const accepted = await makeApplicant('Accepted Girl', 'accepted@example.org');
      await decline(declined.applicationId).expect(200);
      await accept(accepted.applicationId).expect(200);

      expect(said(await decline(declined.applicationId).expect(409))).toContain(ALREADY_DECIDED);
      expect(said(await decline(accepted.applicationId).expect(409))).toContain(ALREADY_DECIDED);

      expect((await applicationState(accepted.applicationId)).status).toBe('ACCEPTED'); // untouched
      expect(await kit.prisma.emailOutbox.count({ where: { template: 'application-declined' } })).toBe(1);
    });

    it('answers 404 for an unknown application and rejects an over-long note', async () => {
      const applicant = await makeApplicant();
      await decline(SOME_ID).expect(404);
      await decline(applicant.applicationId, 'x'.repeat(1001)).expect(400);
      expect((await applicationState(applicant.applicationId)).status).toBe('PENDING');
    });
  });

  // ------------------------------------------------------------------ reopen

  describe('reopening', () => {
    it('puts a declined application back to pending and clears the decision', async () => {
      const applicant = await makeApplicant();
      await decline(applicant.applicationId, 'Outside our age range').expect(200);

      const res = await reopen(applicant.applicationId).expect(200);
      expect(res.body.application).toMatchObject({ status: 'PENDING', reviewedAt: null });

      expect(await applicationState(applicant.applicationId)).toMatchObject({
        status: 'PENDING',
        reviewedById: null,
        reviewedAt: null,
        decisionNote: null,
      });
      expect(await kit.prisma.auditLog.count({ where: { action: 'application.reopened', entityId: applicant.applicationId } })).toBe(1);

      // She is told nothing: the only decline email is the one sent earlier.
      expect(await kit.prisma.emailOutbox.count({ where: { template: 'application-declined' } })).toBe(1);
      expect(await kit.prisma.emailOutbox.count({ where: { template: 'application-accepted' } })).toBe(0);
    });

    it('lets her be accepted afterwards, but not while she is still declined', async () => {
      const applicant = await makeApplicant();
      await decline(applicant.applicationId).expect(200);
      await accept(applicant.applicationId).expect(409); // declined: must be reopened first

      await reopen(applicant.applicationId).expect(200);
      await accept(applicant.applicationId).expect(200);

      expect((await applicationState(applicant.applicationId)).status).toBe('ACCEPTED');
      expect(await kit.prisma.enrollment.count()).toBe(1);
    });

    it('refuses a pending or an accepted application', async () => {
      const pending = await makeApplicant('Pending Girl', 'pending@example.org');
      const accepted = await makeApplicant('Accepted Girl', 'accepted@example.org');
      await accept(accepted.applicationId).expect(200);

      expect(said(await reopen(pending.applicationId).expect(409))).toContain('Only declined applications can be reopened.');
      expect(said(await reopen(accepted.applicationId).expect(409))).toContain('Only declined applications can be reopened.');
      expect((await applicationState(accepted.applicationId)).status).toBe('ACCEPTED');
    });

    it('answers 404 for an unknown application', async () => {
      await reopen(SOME_ID).expect(404);
    });
  });

  // ------------------------------------------------------------------- audit

  it('keeps names, emails, phone numbers and private notes out of every decision audit entry', async () => {
    const accepted = await makeApplicant('Ada Okoye', 'ada@example.org');
    const declined = await makeApplicant('Bola Adeyemi', 'bola@example.org');
    await accept(accepted.applicationId, cohortId, 'Strong application').expect(200);
    await decline(declined.applicationId, 'Outside our age range').expect(200);
    await reopen(declined.applicationId).expect(200);

    const rows = await kit.prisma.auditLog.findMany({ where: { action: { startsWith: 'application.' } } });
    expect(rows.map((row) => row.action).sort()).toEqual(['application.accepted', 'application.declined', 'application.reopened']);

    const everything = JSON.stringify(rows);
    for (const secret of [
      'Ada Okoye',
      'ada@example.org',
      'Bola Adeyemi',
      'bola@example.org',
      '08012345678',
      'Government College',
      'Strong application',
      'Outside our age range',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});