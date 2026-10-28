/**
 * students-signup.integration.spec.ts
 * ---------------------------------------------------------------------------
 * A student signs up and applies, confirms her email, and looks at her
 * dashboard. Real app, PostgreSQL and Redis (the TEST ones).
 *
 * Covers: the all-or-nothing signup, duplicate emails, the under-18 guardian
 * rules, the hidden bot trap, the signup rate limit, one-time and expiring
 * confirmation links, and who may use the student routes.
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { AuthTokenType, Role } from '@prisma/client';
import request from 'supertest';

import { INVALID_LINK_ERROR } from '../src/auth/auth.constants';
import { OutboxService } from '../src/common/outbox/outbox.service';
import {
  DASHBOARD_MESSAGES,
  DUPLICATE_EMAIL_MESSAGE,
  GUARDIAN_CONSENT_REQUIRED_MESSAGE,
  GUARDIAN_PARTIAL_MESSAGE,
  GUARDIAN_REQUIRED_MESSAGE,
  PASSWORDS_DIFFER_MESSAGE,
  UNKNOWN_TRACK_MESSAGE,
} from '../src/students/students.constants';
import { dayOffset, makeTrack } from './helpers/catalog-helpers';
import { createTestKit, GOOD_PASSWORD, TestAgent, TestKit } from './helpers/test-kit';

const REGISTER = '/api/v1/students/register';
const VERIFY = '/api/v1/students/verify-email';
const RESEND = '/api/v1/students/me/resend-verification';
const DASHBOARD = '/api/v1/students/me/dashboard';

const ADULT_DOB = '2000-05-05';
const ADULT_EMAIL = 'ada@example.org';

/** A date of birth that makes her about 15 years old today. */
const minorDob = () => dayOffset(-(15 * 365 + 4));

/** Exactly 18 today (her birthday is today). */
const eighteenToday = () => {
  const today = dayOffset(0);
  const monthDay = today.slice(5);
  return `${Number(today.slice(0, 4)) - 18}-${monthDay === '02-29' ? '02-28' : monthDay}`;
};

/** Turns 18 tomorrow, so she is still 17 today. */
const eighteenTomorrow = () => {
  const tomorrow = dayOffset(1);
  const monthDay = tomorrow.slice(5);
  return `${Number(tomorrow.slice(0, 4)) - 18}-${monthDay === '02-29' ? '03-01' : monthDay}`;
};

const said = (res: { body: unknown }) => JSON.stringify(res.body);

describe('Student signup, email confirmation and dashboard (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;
  let trackId: string;

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    await kit.createUser({ email: 'admin@example.org', fullName: 'Ada Admin', role: Role.ADMIN });
    admin = await kit.loginAgent('admin@example.org', 'admin');
    trackId = await makeTrack(admin);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const payload = (overrides: Record<string, unknown> = {}) => ({
    fullName: 'Ada Okoye',
    email: ADULT_EMAIL,
    phone: '08012345678',
    dateOfBirth: ADULT_DOB,
    location: 'Lagos',
    schoolName: 'Government College',
    gradeLevel: 'SS2',
    preferredTrackId: trackId,
    whyJoin: 'I love building things with code.',
    hopeToLearn: 'How robots and AI really work.',
    password: GOOD_PASSWORD,
    confirmPassword: GOOD_PASSWORD,
    acceptTerms: true,
    acceptPrivacy: true,
    ...overrides,
  });

  /** One signup from a fresh browser (its own cookie jar). */
  const signup = (overrides: Record<string, unknown> = {}) => kit.agent().post(REGISTER).send(payload(overrides));

  /** Everything a signup is supposed to create, counted. */
  const counts = async () => ({
    users: await kit.prisma.user.count({ where: { role: Role.STUDENT } }),
    profiles: await kit.prisma.studentProfile.count(),
    applications: await kit.prisma.studentApplication.count(),
    links: await kit.prisma.authToken.count({ where: { type: AuthTokenType.EMAIL_VERIFICATION } }),
    emails: await kit.prisma.emailOutbox.count(),
    registeredAudits: await kit.prisma.auditLog.count({ where: { action: 'student.registered' } }),
  });
  const NOTHING = { users: 0, profiles: 0, applications: 0, links: 0, emails: 0, registeredAudits: 0 };

  // ------------------------------------------------------------------ signup

  describe('signup', () => {
    it('creates the account, profile, application, confirmation link, two emails and an audit entry', async () => {
      const res = await signup().expect(201);

      expect(res.body).toMatchObject({
        user: { email: ADULT_EMAIL, fullName: 'Ada Okoye', role: 'STUDENT' },
        application: { status: 'PENDING' },
        emailVerified: false,
      });
      expect(said(res)).not.toContain(GOOD_PASSWORD);
      expect(said(res)).not.toContain('passwordHash');

      const user = await kit.prisma.user.findUniqueOrThrow({
        where: { email: ADULT_EMAIL },
        include: { studentProfile: true, studentApplication: true },
      });
      expect(user).toMatchObject({ role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: null });
      expect(user.passwordHash).toBeTruthy();
      expect(user.passwordHash).not.toBe(GOOD_PASSWORD);

      expect(user.studentProfile).toMatchObject({
        phone: '08012345678',
        location: 'Lagos',
        schoolName: 'Government College',
        gradeLevel: 'SS2',
        guardianName: null,
        guardianEmail: null,
        guardianPhone: null,
      });
      expect(user.studentProfile?.dateOfBirth.toISOString().slice(0, 10)).toBe(ADULT_DOB);

      expect(user.studentApplication).toMatchObject({
        status: 'PENDING',
        preferredTrackId: trackId,
        whyJoin: 'I love building things with code.',
        hopeToLearn: 'How robots and AI really work.',
        consentVersion: 'v1',
        guardianConsentAt: null,
        reviewedAt: null,
        reviewedById: null,
        decisionNote: null,
      });
      expect(user.studentApplication?.consentAcceptedAt).toBeInstanceOf(Date);

      const emails = await kit.prisma.emailOutbox.findMany({ orderBy: { template: 'asc' } });
      expect(emails.map((e) => e.template)).toEqual(['application-received', 'verify-email']);
      expect(emails.every((e) => e.toEmail === ADULT_EMAIL)).toBe(true);
      expect(emails[0].payload).toMatchObject({ fullName: 'Ada Okoye', preferredTrack: 'AI & Robotics' });

      const links = await kit.prisma.authToken.findMany({ where: { type: AuthTokenType.EMAIL_VERIFICATION } });
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ userId: user.id, usedAt: null });

      const audits = await kit.prisma.auditLog.findMany({ where: { action: 'student.registered' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorId: user.id,
        entityId: user.id,
        metadata: { preferredTrackId: trackId, minor: false },
      });
    });

    it('makes the confirmation link last 24 hours', async () => {
      await signup().expect(201);
      const link = await kit.prisma.authToken.findFirstOrThrow({ where: { type: AuthTokenType.EMAIL_VERIFICATION } });
      const hours = (link.expiresAt.getTime() - link.createdAt.getTime()) / (60 * 60 * 1000);
      expect(hours).toBeCloseTo(24, 1);
    });

    it('signs her in straight away, on a "pending, locked" dashboard', async () => {
      const student = kit.agent();
      const res = await student.post(REGISTER).send(payload()).expect(201);
      expect(res.headers['set-cookie']).toBeDefined();

      const dashboard = await student.get(DASHBOARD).expect(200);
      expect(dashboard.body).toMatchObject({
        student: { email: ADULT_EMAIL, fullName: 'Ada Okoye', emailVerified: false },
        application: { status: 'PENDING', preferredTrack: { id: trackId, name: 'AI & Robotics' } },
        enrollment: null,
        courseAccess: 'locked',
        message: DASHBOARD_MESSAGES.pending,
      });
    });

    it('lets her sign in later through the student portal with the same password', async () => {
      await signup().expect(201);
      const again = await kit.loginAgent(ADULT_EMAIL, 'student');
      await again.get(DASHBOARD).expect(200);
    });

    it('cleans up the email address (spaces, capitals)', async () => {
      const res = await signup({ email: '  ADA@Example.ORG ' }).expect(201);
      expect(res.body.user.email).toBe(ADULT_EMAIL);
      expect(await kit.prisma.user.count({ where: { email: ADULT_EMAIL } })).toBe(1);
    });

    it('keeps personal details out of the audit log', async () => {
      await signup({
        dateOfBirth: minorDob(),
        guardianName: 'Mrs Okoye',
        guardianEmail: 'mum@example.org',
        guardianPhone: '08098765432',
        guardianConsent: true,
      }).expect(201);

      const everything = JSON.stringify(await kit.prisma.auditLog.findMany());
      for (const secret of [
        ADULT_EMAIL,
        'Ada Okoye',
        '08012345678',
        'Government College',
        'Lagos',
        'Mrs Okoye',
        'mum@example.org',
        '08098765432',
        minorDob(),
      ]) {
        expect(everything).not.toContain(secret);
      }
    });

    it('is all-or-nothing: if the second email cannot be queued, nothing is left behind', async () => {
      const outbox = kit.app.get(OutboxService);
      const realEnqueue = outbox.enqueue.bind(outbox); // keep the real one BEFORE it is replaced
      jest
        .spyOn(outbox, 'enqueue')
        .mockImplementationOnce(realEnqueue) // the confirmation email goes in...
        .mockRejectedValueOnce(new Error('simulated failure')); // ...then the next one fails

      const res = await signup().expect(500);

      expect(said(res)).not.toContain('simulated'); // internal details never leak
      expect(res.headers['set-cookie']).toBeUndefined(); // and she is not signed in
      expect(await counts()).toEqual(NOTHING);
    });

    describe('duplicate email', () => {
      it('answers with a clear message and creates nothing more', async () => {
        await signup().expect(201);
        const second = await signup({ fullName: 'Someone Else' }).expect(409);

        expect(said(second)).toContain(DUPLICATE_EMAIL_MESSAGE);
        expect(await counts()).toMatchObject({ users: 1, profiles: 1, applications: 1, links: 1 });
      });

      it('treats the same address in different capitals as the same account', async () => {
        await signup().expect(201);
        await signup({ email: 'ADA@EXAMPLE.ORG' }).expect(409);
        expect(await counts()).toMatchObject({ users: 1 });
      });

      it('refuses an address that already belongs to someone else (not only students)', async () => {
        await kit.createUser({ email: 'taken@example.org', role: Role.INSTRUCTOR });
        const res = await signup({ email: 'taken@example.org' }).expect(409);
        expect(said(res)).toContain(DUPLICATE_EMAIL_MESSAGE);
        expect(await counts()).toEqual(NOTHING);
      });
    });

    describe('rejected signups save nothing', () => {
      it('refuses passwords that do not match', async () => {
        const res = await signup({ confirmPassword: 'Different-Pass-99!' }).expect(400);
        expect(said(res)).toContain(PASSWORDS_DIFFER_MESSAGE);
        expect(await counts()).toEqual(NOTHING);
      });

      it('refuses a weak password', async () => {
        await signup({ password: 'abc', confirmPassword: 'abc' }).expect(400);
        expect(await counts()).toEqual(NOTHING);
      });

      it('refuses a date of birth in the future', async () => {
        const res = await signup({ dateOfBirth: dayOffset(1) }).expect(400);
        expect(said(res)).toContain('The date of birth cannot be in the future.');
        expect(await counts()).toEqual(NOTHING);
      });

      it('refuses an implausibly old date of birth', async () => {
        const res = await signup({ dateOfBirth: '1900-01-01' }).expect(400);
        expect(said(res)).toContain('Please check the date of birth.');
        expect(await counts()).toEqual(NOTHING);
      });

      it('refuses a track that does not exist', async () => {
        const res = await signup({ preferredTrackId: '11111111-1111-4111-8111-111111111111' }).expect(400);
        expect(said(res)).toContain(UNKNOWN_TRACK_MESSAGE);
        expect(await counts()).toEqual(NOTHING);
      });

      it('refuses a track that has been archived', async () => {
        const archived = await admin.post(`/api/v1/admin/tracks/${trackId}/archive`);
        expect(archived.status).toBeLessThan(300);

        const res = await signup().expect(400);
        expect(said(res)).toContain(UNKNOWN_TRACK_MESSAGE);
        expect(await counts()).toEqual(NOTHING);
      });

      it('cannot be used to choose a role, a status or a confirmed email', async () => {
        await signup({ role: 'ADMIN' }).expect(400);
        await signup({ status: 'SUSPENDED' }).expect(400);
        await signup({ emailVerifiedAt: '2020-01-01T00:00:00.000Z' }).expect(400);
        expect(await counts()).toEqual(NOTHING);
        expect(await kit.prisma.user.count({ where: { email: ADULT_EMAIL } })).toBe(0);
      });
    });

    describe('applicants under 18', () => {
      const guardian = {
        guardianName: 'Mrs Okoye',
        guardianEmail: 'MUM@Example.org',
        guardianPhone: '08098765432',
      };

      it('need all three guardian details', async () => {
        const none = await signup({ dateOfBirth: minorDob(), guardianConsent: true }).expect(400);
        expect(said(none)).toContain(GUARDIAN_REQUIRED_MESSAGE);

        const partial = await signup({
          dateOfBirth: minorDob(),
          guardianName: 'Mrs Okoye',
          guardianEmail: 'mum@example.org',
          guardianConsent: true,
        }).expect(400);
        expect(said(partial)).toContain(GUARDIAN_REQUIRED_MESSAGE);

        expect(await counts()).toEqual(NOTHING);
      });

      it('need the guardian to agree', async () => {
        const missing = await signup({ dateOfBirth: minorDob(), ...guardian }).expect(400);
        expect(said(missing)).toContain(GUARDIAN_CONSENT_REQUIRED_MESSAGE);

        const no = await signup({ dateOfBirth: minorDob(), ...guardian, guardianConsent: false }).expect(400);
        expect(said(no)).toContain(GUARDIAN_CONSENT_REQUIRED_MESSAGE);

        expect(await counts()).toEqual(NOTHING);
      });

      it('are accepted with full guardian details and consent, which are recorded', async () => {
        await signup({ dateOfBirth: minorDob(), ...guardian, guardianConsent: true }).expect(201);

        const user = await kit.prisma.user.findUniqueOrThrow({
          where: { email: ADULT_EMAIL },
          include: { studentProfile: true, studentApplication: true },
        });
        expect(user.studentProfile).toMatchObject({
          guardianName: 'Mrs Okoye',
          guardianEmail: 'mum@example.org', // lowercased
          guardianPhone: '08098765432',
        });
        expect(user.studentApplication?.guardianConsentAt).toBeInstanceOf(Date);

        const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'student.registered' } });
        expect(audit.metadata).toMatchObject({ minor: true });
      });

      it('count as adults from the day they turn 18, and not a day earlier', async () => {
        await signup({ dateOfBirth: eighteenToday() }).expect(201); // no guardian needed

        const almost = await signup({ email: 'almost@example.org', dateOfBirth: eighteenTomorrow() }).expect(400);
        expect(said(almost)).toContain(GUARDIAN_REQUIRED_MESSAGE);
      });
    });

    describe('adult applicants and guardian details', () => {
      it('may not give only some of the guardian details', async () => {
        const res = await signup({ guardianName: 'Mrs Okoye' }).expect(400);
        expect(said(res)).toContain(GUARDIAN_PARTIAL_MESSAGE);
        expect(await counts()).toEqual(NOTHING);
      });

      it('may give all three if they wish', async () => {
        await signup({
          guardianName: 'Mrs Okoye',
          guardianEmail: 'mum@example.org',
          guardianPhone: '08098765432',
        }).expect(201);
        expect((await kit.prisma.studentProfile.findFirstOrThrow()).guardianName).toBe('Mrs Okoye');
      });
    });

    describe('the hidden bot trap', () => {
      it('pretends it worked but saves nothing, sets no cookie, and records the attempt', async () => {
        const res = await signup({ website: 'http://spam.example' }).expect(201);

        expect(res.body).toEqual({ received: true });
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(await counts()).toEqual(NOTHING);
        expect(await kit.prisma.auditLog.count({ where: { action: 'student.signup_trap_triggered' } })).toBe(1);
      });

      it('does not trigger on an empty or blank hidden field', async () => {
        await signup({ website: '' }).expect(201);
        await signup({ email: 'blank@example.org', website: '   ' }).expect(201);
        expect(await counts()).toMatchObject({ users: 2 });
      });
    });

    describe('rate limit', () => {
      it('allows 10 signup attempts in 10 minutes from one address, then says "too many"', async () => {
        const attempt = () => signup({ confirmPassword: 'Different-Pass-99!' });

        for (let i = 0; i < 10; i += 1) await attempt().expect(400); // refused cheaply, but still counted
        await attempt().expect(429);

        expect(await counts()).toEqual(NOTHING); // and nothing was saved
      });
    });
  });

  // ---------------------------------------------------------- email links

  describe('confirming the email address', () => {
    /** Signs up and returns her browser plus the emailed secret. */
    const signedUp = async () => {
      const student = kit.agent();
      await student.post(REGISTER).send(payload()).expect(201);
      return { student, token: await kit.latestEmailToken('verify-email') };
    };

    const confirm = (token: string) => request(kit.server()).post(VERIFY).send({ token });

    it('works with the emailed link, even from a different browser, and is audited', async () => {
      const { student, token } = await signedUp();

      await confirm(token).expect(200);

      const user = await kit.prisma.user.findUniqueOrThrow({ where: { email: ADULT_EMAIL } });
      expect(user.emailVerifiedAt).toBeInstanceOf(Date);

      const link = await kit.prisma.authToken.findFirstOrThrow({ where: { userId: user.id } });
      expect(link.usedAt).toBeInstanceOf(Date);

      expect(
        await kit.prisma.auditLog.count({ where: { action: 'student.email_verified', actorId: user.id } }),
      ).toBe(1);
      expect((await student.get(DASHBOARD).expect(200)).body.student.emailVerified).toBe(true);
    });

    it('works only once', async () => {
      const { token } = await signedUp();
      await confirm(token).expect(200);

      const before = (await kit.prisma.user.findUniqueOrThrow({ where: { email: ADULT_EMAIL } })).emailVerifiedAt;
      const second = await confirm(token).expect(400);
      expect(said(second)).toContain(INVALID_LINK_ERROR);

      const after = (await kit.prisma.user.findUniqueOrThrow({ where: { email: ADULT_EMAIL } })).emailVerifiedAt;
      expect(after).toEqual(before);
    });

    it('refuses a made-up secret, a missing secret and a secret of the wrong length', async () => {
      await signedUp();
      const made = await confirm('this-is-not-a-real-token-0123456789abcdef').expect(400);
      expect(said(made)).toContain(INVALID_LINK_ERROR);

      await request(kit.server()).post(VERIFY).send({}).expect(400);
      await confirm('short').expect(400);

      expect((await kit.prisma.user.findUniqueOrThrow({ where: { email: ADULT_EMAIL } })).emailVerifiedAt).toBeNull();
    });

    it('refuses an expired link', async () => {
      const { token } = await signedUp();
      await kit.prisma.authToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      const res = await confirm(token).expect(400);
      expect(said(res)).toContain(INVALID_LINK_ERROR);
      expect((await kit.prisma.user.findUniqueOrThrow({ where: { email: ADULT_EMAIL } })).emailVerifiedAt).toBeNull();
    });

    describe('asking for a new link', () => {
      it('sends a new link, voids the old one, and is audited', async () => {
        const { student, token: oldToken } = await signedUp();

        await student.post(RESEND).expect(200);
        const newToken = await kit.latestEmailToken('verify-email');

        expect(newToken).not.toBe(oldToken);
        expect(await kit.prisma.emailOutbox.count({ where: { template: 'verify-email' } })).toBe(2);

        await confirm(oldToken).expect(400); // the old link no longer works
        await confirm(newToken).expect(200); // the new one does

        expect(await kit.prisma.auditLog.count({ where: { action: 'student.verification_resent' } })).toBe(1);
      });

      it('is refused once the address is already confirmed', async () => {
        const { student, token } = await signedUp();
        await confirm(token).expect(200);

        const res = await student.post(RESEND).expect(409);
        expect(said(res)).toContain('already confirmed');
      });

      it('needs a signed-in student', async () => {
        await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
        const teacher = await kit.loginAgent('teacher@example.org', 'instructor');

        await request(kit.server()).post(RESEND).expect(401);
        await teacher.post(RESEND).expect(403);
        await admin.post(RESEND).expect(403);
      });
    });
  });

  // ------------------------------------------------------------- dashboard

  describe('the student dashboard', () => {
    it('refuses signed-out visitors (401), instructors (403) and admins (403)', async () => {
      await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
      const teacher = await kit.loginAgent('teacher@example.org', 'instructor');

      await request(kit.server()).get(DASHBOARD).expect(401);
      await teacher.get(DASHBOARD).expect(403);
      await admin.get(DASHBOARD).expect(403);
    });

    it('shows a student who has no application a clear "not found" message, and a locked course', async () => {
      await kit.createUser({ email: 'noapp@example.org', role: Role.STUDENT });
      const student = await kit.loginAgent('noapp@example.org', 'student');

      const res = await student.get(DASHBOARD).expect(200);
      expect(res.body).toMatchObject({
        application: null,
        enrollment: null,
        courseAccess: 'locked',
        message: DASHBOARD_MESSAGES.none,
      });
    });

    it('never includes private details or the admin note', async () => {
      const student = kit.agent();
      await student.post(REGISTER).send(payload()).expect(201);

      const res = await student.get(DASHBOARD).expect(200);
      const body = said(res);
      for (const hidden of ['decisionNote', 'dateOfBirth', '08012345678', 'Government College', 'passwordHash']) {
        expect(body).not.toContain(hidden);
      }
    });
  });
});