/**
 * retention.integration.spec.ts
 * ---------------------------------------------------------------------------
 * The rule "two months after an application is DECLINED, the applicant's
 * personal data is removed". Real app, PostgreSQL and Redis (the TEST ones).
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { Role } from '@prisma/client';
import request from 'supertest';

import { AuditService } from '../src/common/audit/audit.service';
import {
  monthsBefore,
  REMOVED_ACCOUNT_MESSAGE,
  REMOVED_REOPEN_MESSAGE,
  removedAccountEmail,
} from '../src/retention/retention.constants';
import { RetentionService } from '../src/retention/retention.service';
import { makeStack } from './helpers/catalog-helpers';
import { enroll, makeApplicant } from './helpers/student-helpers';
import { createTestKit, GOOD_PASSWORD, TestAgent, TestKit } from './helpers/test-kit';

const APPLICATIONS = '/api/v1/admin/applications';
const STUDENTS = '/api/v1/admin/students';
const DAY_MS = 24 * 60 * 60 * 1000;

const said = (res: { body: unknown }) => JSON.stringify(res.body);

describe('Retention: removing declined applicants’ personal data (integration)', () => {
  let kit: TestKit;
  let retention: RetentionService;
  let admin: TestAgent;
  let adminId: string;
  let trackId: string;
  let cohortId: string;

  beforeAll(async () => {
    kit = await createTestKit();
    retention = kit.app.get(RetentionService);
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    adminId = (await kit.createUser({ email: 'admin@example.org', fullName: 'Pat Admin', role: Role.ADMIN })).id;
    admin = await kit.loginAgent('admin@example.org', 'admin');
    ({ trackId, cohortId } = await makeStack(admin));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ----------------------------------------------------------------- helpers

  /** `months` whole months ago, then `extraDays` days further back (negative = more recent). */
  const decidedAt = (months: number, extraDays = 0) => new Date(monthsBefore(new Date(), months).getTime() - extraDays * DAY_MS);

  /** An applicant who was DECLINED at `reviewedAt`, with a private note. */
  const declined = async (name: string, email: string, reviewedAt: Date) => {
    const person = await makeApplicant(kit, trackId, { fullName: name, email });
    await kit.prisma.studentApplication.update({
      where: { id: person.applicationId },
      data: { status: 'DECLINED', reviewedAt, reviewedById: adminId, decisionNote: 'Outside our age range' },
    });
    return person;
  };

  const stateOf = async (studentId: string) => ({
    user: await kit.prisma.user.findUniqueOrThrow({ where: { id: studentId } }),
    profiles: await kit.prisma.studentProfile.count({ where: { userId: studentId } }),
    application: await kit.prisma.studentApplication.findUniqueOrThrow({ where: { studentId } }),
  });

  const untouched = async (person: { studentId: string; email: string }) => {
    const { user, profiles, application } = await stateOf(person.studentId);
    expect(user.email).toBe(person.email);
    expect(profiles).toBe(1);
    expect(application.whyJoin).not.toBe('[removed]');
  };

  const removed = async (person: { studentId: string }) => {
    const { user, profiles } = await stateOf(person.studentId);
    expect(user.email).toBe(removedAccountEmail(person.studentId));
    expect(profiles).toBe(0);
  };

  // ------------------------------------------------------------ what is removed

  describe('an applicant declined more than two months ago', () => {
    it('loses every personal detail, and her account is anonymised and disabled', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(2, 1));
      await kit.loginAgent('ada@example.org', 'student'); // she has an open session and a last-login time
      await kit.prisma.authToken.create({
        data: {
          userId: ada.studentId,
          type: 'EMAIL_VERIFICATION',
          tokenHash: ada.studentId.replace(/-/g, '').padEnd(64, '0'),
          expiresAt: new Date(Date.now() + DAY_MS),
        },
      });
      await kit.prisma.emailOutbox.createMany({
        data: [
          { toEmail: 'ada@example.org', template: 'application-declined', payload: { fullName: 'Ada Okoye' } },
          { toEmail: 'ada@example.org', template: 'verify-email', payload: { fullName: 'Ada Okoye', actionUrl: 'http://localhost:3000/v?token=abc' } },
          { toEmail: 'someone.else@example.org', template: 'application-declined', payload: { fullName: 'Someone Else' } },
        ],
      });

      const result = await retention.removeDue();

      expect(result).toEqual({ removed: 1, skipped: 0, failed: 0 });

      const { user, profiles, application } = await stateOf(ada.studentId);
      expect(user).toMatchObject({
        role: 'STUDENT',
        email: removedAccountEmail(ada.studentId),
        fullName: 'Removed applicant',
        passwordHash: null,
        status: 'SUSPENDED',
        emailVerifiedAt: null,
        lastLoginAt: null,
      });
      expect(profiles).toBe(0);
      expect(application).toMatchObject({
        status: 'DECLINED',
        whyJoin: '[removed]',
        hopeToLearn: '[removed]',
        stemExperience: null,
        decisionNote: null,
        reviewedById: adminId, // the fact of the decision stays
        preferredTrackId: trackId,
        consentVersion: 'v1', // so does the record that she consented
      });
      expect(application.reviewedAt).toBeInstanceOf(Date);

      expect(await kit.prisma.session.count({ where: { userId: ada.studentId } })).toBe(0);
      expect(await kit.prisma.authToken.count({ where: { userId: ada.studentId } })).toBe(0);

      // Emails addressed to her are gone; other people's are not.
      expect(await kit.prisma.emailOutbox.count({ where: { toEmail: 'ada@example.org' } })).toBe(0);
      expect(await kit.prisma.emailOutbox.count({ where: { toEmail: 'someone.else@example.org' } })).toBe(1);
    });

    it('is audited without any personal details', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(2, 1));

      await retention.removeDue();

      const audits = await kit.prisma.auditLog.findMany({ where: { action: 'application.personal_data_removed' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorId: null, // done by the system, not by a person
        entityType: 'student_application',
        entityId: ada.applicationId,
        metadata: { studentId: ada.studentId },
      });

      const everything = JSON.stringify(await kit.prisma.auditLog.findMany());
      for (const secret of ['Ada Okoye', 'ada@example.org', '08012345678', 'Government College', 'Outside our age range']) {
        expect(everything).not.toContain(secret);
      }
    });

    it('can no longer sign in, under her old address or the new one', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(2, 1));
      await retention.removeDue();

      for (const email of ['ada@example.org', removedAccountEmail(ada.studentId)]) {
        const res = await kit.agent().post('/api/v1/auth/login').send({ email, password: GOOD_PASSWORD, portal: 'student' });
        expect([401, 403]).toContain(res.status);
      }
    });

    it('frees her old email address so she can apply again', async () => {
      await declined('Ada Okoye', 'ada@example.org', decidedAt(2, 1));
      await retention.removeDue();

      await kit
        .agent()
        .post('/api/v1/students/register')
        .send({
          fullName: 'Ada Okoye',
          email: 'ada@example.org',
          phone: '08012345678',
          dateOfBirth: '2000-05-05',
          location: 'Lagos',
          schoolName: 'Government College',
          gradeLevel: 'SS2',
          preferredTrackId: trackId,
          whyJoin: 'I would like to apply again.',
          hopeToLearn: 'How robots and AI really work.',
          password: GOOD_PASSWORD,
          confirmPassword: GOOD_PASSWORD,
          acceptTerms: true,
          acceptPrivacy: true,
        })
        .expect(201);
    });
  });

  // ------------------------------------------------------------ who is due

  describe('who is due', () => {
    it('keeps the data for two months: a day short is left alone, a day over is removed', async () => {
      const justUnder = await declined('Just Under', 'under@example.org', decidedAt(2, -1));
      const justOver = await declined('Just Over', 'over@example.org', decidedAt(2, 1));
      const recent = await declined('Recent', 'recent@example.org', decidedAt(1));
      const today = await declined('Today', 'today@example.org', new Date());

      const result = await retention.removeDue();

      expect(result).toEqual({ removed: 1, skipped: 0, failed: 0 });
      await removed(justOver);
      for (const person of [justUnder, recent, today]) await untouched(person);
    });

    it('counts from the date of the DECISION, not the date she applied', async () => {
      const person = await makeApplicant(kit, trackId, {
        email: 'ada@example.org',
        submittedAt: decidedAt(12), // applied a year ago
      });
      await admin.post(`${APPLICATIONS}/${person.applicationId}/decline`).send({}).expect(200); // declined just now

      expect(await retention.removeDue()).toMatchObject({ removed: 0 });
      await untouched(person);
    });

    it('never touches pending or accepted applicants, however old', async () => {
      const pending = await makeApplicant(kit, trackId, {
        fullName: 'Pending Girl',
        email: 'pending@example.org',
        submittedAt: decidedAt(24),
      });
      const accepted = await makeApplicant(kit, trackId, { fullName: 'Accepted Girl', email: 'accepted@example.org' });
      await admin.post(`${APPLICATIONS}/${accepted.applicationId}/accept`).send({ cohortId }).expect(200);
      await kit.prisma.studentApplication.update({ where: { id: accepted.applicationId }, data: { reviewedAt: decidedAt(24) } });

      expect(await retention.removeDue()).toEqual({ removed: 0, skipped: 0, failed: 0 });
      await untouched(pending);
      await untouched(accepted);
    });

    it('leaves a reopened application alone', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(3));
      await admin.post(`${APPLICATIONS}/${ada.applicationId}/reopen`).expect(200);

      expect(await retention.removeDue()).toMatchObject({ removed: 0 });
      await untouched(ada);
    });

    it('leaves alone anyone who is enrolled in a cohort', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(3));
      await enroll(kit, ada.studentId, cohortId);

      expect(await retention.countDue()).toBe(0);
      expect(await retention.removeDue()).toMatchObject({ removed: 0 });
      await untouched(ada);
    });

    it('only touches the people who are due, and leaves everyone else’s data intact', async () => {
      const due = await declined('Due Girl', 'due@example.org', decidedAt(3));
      const notDue = await declined('Not Due', 'notdue@example.org', decidedAt(1));

      await retention.removeDue();

      await removed(due);
      await untouched(notDue);
      expect(await kit.prisma.user.count({ where: { email: 'admin@example.org' } })).toBe(1);
    });

    it('works from the date it is given', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(1)); // too recent today...
      const threeMonthsOn = new Date(Date.now() + 3 * 31 * DAY_MS);

      expect(await retention.countDue()).toBe(0);
      expect(await retention.countDue(threeMonthsOn)).toBe(1); // ...but due later
      expect(await retention.removeDue(threeMonthsOn)).toMatchObject({ removed: 1 });
      await removed(ada);
    });

    it('calculates the cut-off exactly two calendar months back', () => {
      expect(retention.cutoff(new Date('2026-10-25T00:00:00Z')).toISOString()).toBe('2026-08-25T00:00:00.000Z');
    });
  });

  // ----------------------------------------------------------- running it

  describe('running it', () => {
    it('counting who is due changes nothing', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(3));

      expect(await retention.countDue()).toBe(1);
      expect(await retention.countDue()).toBe(1);

      await untouched(ada);
      expect(await kit.prisma.auditLog.count({ where: { action: 'application.personal_data_removed' } })).toBe(0);
    });

    it('is safe to run again: nobody is processed twice', async () => {
      await declined('Ada Okoye', 'ada@example.org', decidedAt(3));

      expect(await retention.removeDue()).toMatchObject({ removed: 1 });
      expect(await retention.removeDue()).toEqual({ removed: 0, skipped: 0, failed: 0 });
      expect(await kit.prisma.auditLog.count({ where: { action: 'application.personal_data_removed' } })).toBe(1);
    });

    it('handles many applicants, a few at a time', async () => {
      const people = [
        await declined('Girl One', 'one@example.org', decidedAt(3)),
        await declined('Girl Two', 'two@example.org', decidedAt(3, 1)),
        await declined('Girl Three', 'three@example.org', decidedAt(3, 2)),
      ];

      const result = await retention.removeDue(new Date(), 2); // a batch size of 2 needs two rounds

      expect(result).toEqual({ removed: 3, skipped: 0, failed: 0 });
      for (const person of people) await removed(person);
    });

    it('when one applicant fails, nothing changes for her, the others are still done, and the next run retries her', async () => {
      const first = await declined('First Girl', 'first@example.org', decidedAt(4)); // oldest decision: handled first
      const second = await declined('Second Girl', 'second@example.org', decidedAt(3));
      jest.spyOn(kit.app.get(AuditService), 'record').mockRejectedValueOnce(new Error('simulated failure'));

      const result = await retention.removeDue();

      expect(result).toEqual({ removed: 1, skipped: 0, failed: 1 });
      await untouched(first); // the whole transaction was rolled back, not half done
      await removed(second);
      expect(await kit.prisma.emailOutbox.count()).toBe(0);

      jest.restoreAllMocks();
      expect(await retention.removeDue()).toEqual({ removed: 1, skipped: 0, failed: 0 });
      await removed(first);
    });
  });

  // ----------------------------------------- what admins can do afterwards

  describe('afterwards', () => {
    it('her application can no longer be reopened', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(3));
      await retention.removeDue();

      const res = await admin.post(`${APPLICATIONS}/${ada.applicationId}/reopen`).expect(409);

      expect(said(res)).toContain(REMOVED_REOPEN_MESSAGE);
      expect((await stateOf(ada.studentId)).application.status).toBe('DECLINED');
    });

    it('her account can no longer be edited, reactivated or moved', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(3));
      await retention.removeDue();

      const edit = await admin.patch(`${STUDENTS}/${ada.studentId}`).send({ phone: '08011112222' }).expect(409);
      expect(said(edit)).toContain(REMOVED_ACCOUNT_MESSAGE);

      const reactivate = await admin.post(`${STUDENTS}/${ada.studentId}/reactivate`).expect(409);
      expect(said(reactivate)).toContain(REMOVED_ACCOUNT_MESSAGE);

      await admin.post(`${STUDENTS}/${ada.studentId}/suspend`).expect(409); // already suspended
      await admin.post(`${STUDENTS}/${ada.studentId}/move`).send({ cohortId }).expect(409); // not enrolled
    });

    it('admins can still see that an application was made and declined, with no personal data', async () => {
      const ada = await declined('Ada Okoye', 'ada@example.org', decidedAt(3));
      await retention.removeDue();

      const student = await admin.get(`${STUDENTS}/${ada.studentId}`).expect(200);
      expect(student.body.student).toMatchObject({
        fullName: 'Removed applicant',
        email: removedAccountEmail(ada.studentId),
        accountStatus: 'SUSPENDED',
        profile: null,
        application: { status: 'DECLINED', answers: { whyJoin: '[removed]', hopeToLearn: '[removed]', stemExperience: null } },
      });

      const application = await admin.get(`${APPLICATIONS}/${ada.applicationId}`).expect(200);
      expect(application.body.application).toMatchObject({ status: 'DECLINED', profile: null });

      const list = await admin.get(`${APPLICATIONS}?status=DECLINED`).expect(200);
      expect(list.body.items).toHaveLength(1);

      const body = said(student) + said(application);
      for (const secret of ['Ada Okoye', 'ada@example.org', '08012345678', '2000-05-05', 'Government College', 'Outside our age range']) {
        expect(body).not.toContain(secret);
      }
    });

    it('does not affect anyone else’s pages', async () => {
      await declined('Ada Okoye', 'ada@example.org', decidedAt(3));
      const keep = await makeApplicant(kit, trackId, { fullName: 'Bola Adeyemi', email: 'bola@example.org' });
      await retention.removeDue();

      const res = await admin.get(`${APPLICATIONS}/${keep.applicationId}`).expect(200);
      expect(res.body.application.profile).toMatchObject({ phone: '08012345678', location: 'Lagos' });
      await request(kit.server()).get('/api/v1/public/tracks').expect(200);
    });
  });
});