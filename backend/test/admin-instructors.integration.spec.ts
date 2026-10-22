/**
 * admin-instructors.integration.spec.ts
 * ---------------------------------------------------------------------------
 * End-to-end tests of "admin manages instructors", using the REAL app,
 * PostgreSQL and Redis. Each test tries to break a rule and proves the app
 * says no.
 *
 * Run with:  npm run test:db
 */
import { TEST_APP_ORIGIN } from './helpers/integration-env'; // must stay first: sets the environment

import { AccountStatus, AuthTokenType, Role } from '@prisma/client';
import request from 'supertest';

import { OutboxService } from '../src/common/outbox/outbox.service';
import { createTestKit, GOOD_PASSWORD, TestAgent, TestKit } from './helpers/test-kit';

const INSTRUCTORS = '/api/v1/admin/instructors';
const SOME_ID = '11111111-1111-4111-8111-111111111111';

describe('Admin: instructors (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;
  let adminId: string;

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    const adminUser = await kit.createUser({ email: 'admin@example.org', fullName: 'Ada Admin', role: Role.ADMIN });
    adminId = adminUser.id;
    admin = await kit.loginAgent('admin@example.org', 'admin');
  });

  // ----------------------------------------------------------------- helpers

  /** Creates an instructor through the real route and returns its id. */
  async function createViaApi(email = 'new.teacher@example.org', fullName = 'New Teacher'): Promise<string> {
    const res = await admin.post(INSTRUCTORS).send({ fullName, email }).expect(201);
    return res.body.instructor.id as string;
  }

  /** An instructor who already set a password (as if the invite had been accepted). */
  const createActiveInstructor = (email = 'active.teacher@example.org', fullName = 'Active Teacher') =>
    kit.createUser({ email, fullName, role: Role.INSTRUCTOR, status: AccountStatus.ACTIVE });

  const acceptInvite = (token: string, newPassword = 'Brand-New-Pass-77#') =>
    request(kit.server()).post('/api/v1/auth/accept-invite').send({ token, newPassword });

  const auditActions = async (where = {}) =>
    (await kit.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } })).map((row) => row.action);

  // ---------------------------------------------------- who may use these routes

  describe('who may use these routes', () => {
    const routes: Array<['get' | 'post' | 'patch', string]> = [
      ['post', INSTRUCTORS],
      ['get', INSTRUCTORS],
      ['get', `${INSTRUCTORS}/${SOME_ID}`],
      ['patch', `${INSTRUCTORS}/${SOME_ID}`],
      ['post', `${INSTRUCTORS}/${SOME_ID}/resend-invite`],
      ['post', `${INSTRUCTORS}/${SOME_ID}/suspend`],
      ['post', `${INSTRUCTORS}/${SOME_ID}/reactivate`],
      ['get', '/api/v1/admin/audit-logs'],
    ];

    it('refuses signed-out visitors with 401 on every admin route', async () => {
      for (const [method, url] of routes) {
        await request(kit.server())[method](url).send({}).expect(401);
      }
    });

    it('refuses students and instructors with 403 on every admin route', async () => {
      await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
      await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
      const student = await kit.loginAgent('student@example.org', 'student');
      const teacher = await kit.loginAgent('teacher@example.org', 'instructor');

      for (const [method, url] of routes) {
        await student[method](url).send({}).expect(403);
        await teacher[method](url).send({}).expect(403);
      }
      expect(await kit.prisma.user.count()).toBe(3); // nothing was created along the way
    });
  });

  // ------------------------------------------------------------------ create

  describe('create', () => {
    it('creates an invited instructor, queues the invite email, and records the audit entry', async () => {
      const res = await admin.post(INSTRUCTORS).send({ fullName: 'New Teacher', email: 'new.teacher@example.org' }).expect(201);

      expect(res.body.instructor).toMatchObject({
        email: 'new.teacher@example.org',
        fullName: 'New Teacher',
        status: 'INVITED',
        lastLoginAt: null,
      });

      const user = await kit.prisma.user.findUniqueOrThrow({ where: { email: 'new.teacher@example.org' } });
      expect(user).toMatchObject({
        role: Role.INSTRUCTOR,
        status: AccountStatus.INVITED,
        passwordHash: null, // the instructor chooses their own password later
        createdById: adminId,
      });

      const emails = await kit.prisma.emailOutbox.findMany();
      expect(emails).toHaveLength(1);
      expect(emails[0]).toMatchObject({ toEmail: 'new.teacher@example.org', template: 'instructor-invite', status: 'PENDING' });
      const payload = emails[0].payload as { actionUrl: string; invitedBy: string; fullName: string };
      expect(payload.actionUrl.startsWith(`${TEST_APP_ORIGIN}/set-password?token=`)).toBe(true);
      expect(payload).toMatchObject({ invitedBy: 'Ada Admin', fullName: 'New Teacher' });

      expect(await kit.prisma.authToken.count({ where: { userId: user.id, type: AuthTokenType.INVITE } })).toBe(1);

      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'instructor.created' } });
      expect(audit).toMatchObject({ actorId: adminId, entityType: 'user', entityId: user.id });
    });

    it('never puts secrets in the response', async () => {
      const res = await admin.post(INSTRUCTORS).send({ fullName: 'New Teacher', email: 'new.teacher@example.org' }).expect(201);
      const text = JSON.stringify(res.body).toLowerCase();
      for (const forbidden of ['hash', 'token', 'actionurl', 'set-password', 'password']) {
        expect(text).not.toContain(forbidden);
      }
    });

    it('produces an invite link that really works: set a password, then sign in as an instructor', async () => {
      await createViaApi();
      const token = await kit.latestEmailToken('instructor-invite');

      await acceptInvite(token).expect(200);

      const res = await request(kit.server())
        .post('/api/v1/auth/login')
        .send({ email: 'new.teacher@example.org', password: 'Brand-New-Pass-77#', portal: 'instructor' })
        .expect(200);
      expect(res.body.user.role).toBe('INSTRUCTOR');
    });

    it('cleans up the email address: spaces trimmed, lowercase', async () => {
      await admin.post(INSTRUCTORS).send({ fullName: '  Spaced Name  ', email: '  Mixed.Case@Example.ORG ' }).expect(201);
      const user = await kit.prisma.user.findFirstOrThrow({ where: { role: Role.INSTRUCTOR } });
      expect(user.email).toBe('mixed.case@example.org');
      expect(user.fullName).toBe('Spaced Name');
    });

    it('refuses an email that already belongs to anyone (any role, any capitalisation)', async () => {
      await kit.createUser({ email: 'taken@example.org', role: Role.STUDENT });

      const res = await admin.post(INSTRUCTORS).send({ fullName: 'Someone', email: 'TAKEN@example.org' }).expect(409);
      expect(res.body.message).toContain('already exists');
      expect(await kit.prisma.emailOutbox.count()).toBe(0);
    });

    it('lets exactly one of two simultaneous creations win, with one account and one email', async () => {
      const body = { fullName: 'Race Teacher', email: 'race@example.org' };
      const [a, b] = await Promise.all([admin.post(INSTRUCTORS).send(body), admin.post(INSTRUCTORS).send(body)]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await kit.prisma.user.count({ where: { email: 'race@example.org' } })).toBe(1);
      expect(await kit.prisma.emailOutbox.count()).toBe(1);
      expect(await kit.prisma.authToken.count()).toBe(1);
    });

    it('rejects bad input, and cannot be used to create any other kind of account', async () => {
      const bad = [
        { email: 'a@example.org' }, //                                      no name
        { fullName: 'A', email: 'a@example.org' }, //                       name too short
        { fullName: 'Valid Name', email: 'not-an-email' },
        { fullName: 'Valid Name', email: `${'x'.repeat(250)}@example.org` }, // email too long
        { fullName: 'Valid Name', email: 'a@example.org', role: 'ADMIN' }, //   cannot choose the role
        { fullName: 'Valid Name', email: 'a@example.org', password: 'Sneaky-Pass-1!' }, // no password field
        { fullName: 'Valid Name', email: 'a@example.org', status: 'ACTIVE' },
      ];
      for (const body of bad) {
        await admin.post(INSTRUCTORS).send(body).expect(400);
      }
      expect(await kit.prisma.user.count({ where: { role: { not: Role.ADMIN } } })).toBe(0);
    });

    it('is all-or-nothing: if queuing the email fails, no account, link or audit entry is left behind', async () => {
      jest.spyOn(kit.app.get(OutboxService), 'enqueue').mockRejectedValueOnce(new Error('simulated failure'));

      const res = await admin.post(INSTRUCTORS).send({ fullName: 'Doomed Teacher', email: 'doomed@example.org' }).expect(500);

      expect(res.body.message).not.toContain('simulated'); // internal details never leak
      expect(await kit.prisma.user.count({ where: { email: 'doomed@example.org' } })).toBe(0);
      expect(await kit.prisma.authToken.count()).toBe(0);
      expect(await auditActions({ action: 'instructor.created' })).toEqual([]);
      jest.restoreAllMocks();
    });
  });

  // -------------------------------------------------------------------- list

  describe('list', () => {
    /** 25 instructors named "Teacher 01".."Teacher 25". */
    async function seed25() {
      await kit.prisma.user.createMany({
        data: Array.from({ length: 25 }, (_, i) => {
          const n = String(i + 1).padStart(2, '0');
          return {
            email: `t${n}@example.org`,
            fullName: `Teacher ${n}`,
            role: Role.INSTRUCTOR,
            status: AccountStatus.ACTIVE,
            passwordHash: kit.goodHash,
          };
        }),
      });
    }

    it('returns one page at a time, with totals, and no row appears twice', async () => {
      await seed25();
      const seen: string[] = [];

      const page1 = await admin.get(`${INSTRUCTORS}?page=1&pageSize=10&sortBy=fullName&sortDir=asc`).expect(200);
      expect(page1.body).toMatchObject({ page: 1, pageSize: 10, total: 25, totalPages: 3 });
      expect(page1.body.items).toHaveLength(10);
      expect(page1.body.items[0].fullName).toBe('Teacher 01');

      const page2 = await admin.get(`${INSTRUCTORS}?page=2&pageSize=10&sortBy=fullName&sortDir=asc`).expect(200);
      const page3 = await admin.get(`${INSTRUCTORS}?page=3&pageSize=10&sortBy=fullName&sortDir=asc`).expect(200);
      expect(page3.body.items).toHaveLength(5);
      expect(page3.body.items[4].fullName).toBe('Teacher 25');

      for (const page of [page1, page2, page3]) seen.push(...page.body.items.map((i: { id: string }) => i.id));
      expect(new Set(seen).size).toBe(25);
    });

    it('returns an empty page (not an error) beyond the last page', async () => {
      await seed25();
      const res = await admin.get(`${INSTRUCTORS}?page=9&pageSize=10`).expect(200);
      expect(res.body).toMatchObject({ items: [], total: 25, page: 9 });
    });

    it('uses sensible defaults: page 1, 20 per page', async () => {
      await seed25();
      const res = await admin.get(INSTRUCTORS).expect(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 25, totalPages: 2 });
      expect(res.body.items).toHaveLength(20);
    });

    it('rejects oversized, malformed and unknown parameters', async () => {
      for (const query of [
        'pageSize=101',
        'pageSize=0',
        'page=0',
        'page=abc',
        'page=1.5',
        'foo=bar', //                    unknown parameter
        'sortBy=passwordHash', //        cannot sort by a secret column
        'sortDir=sideways',
        'status=NOPE',
        `search=${'x'.repeat(101)}`,
      ]) {
        await admin.get(`${INSTRUCTORS}?${query}`).expect(400);
      }
    });

    it('searches by part of the name or email, ignoring capitals', async () => {
      await kit.createUser({ email: 'ada@example.org', fullName: 'Ada Lovelace', role: Role.INSTRUCTOR });
      await kit.createUser({ email: 'hopper@example.org', fullName: 'Grace Hopper', role: Role.INSTRUCTOR });
      await kit.createUser({ email: 'turing@example.org', fullName: 'Alan Turing', role: Role.INSTRUCTOR });

      const byName = await admin.get(`${INSTRUCTORS}?search=LOVE`).expect(200);
      expect(byName.body.items.map((i: { fullName: string }) => i.fullName)).toEqual(['Ada Lovelace']);

      const byEmail = await admin.get(`${INSTRUCTORS}?search=hopper@`).expect(200);
      expect(byEmail.body.items.map((i: { fullName: string }) => i.fullName)).toEqual(['Grace Hopper']);

      const none = await admin.get(`${INSTRUCTORS}?search=nobody-matches-this`).expect(200);
      expect(none.body.total).toBe(0);
    });

    it('filters by status', async () => {
      await kit.createUser({ email: 'a@example.org', role: Role.INSTRUCTOR, status: AccountStatus.ACTIVE });
      await kit.createUser({ email: 'b@example.org', role: Role.INSTRUCTOR, status: AccountStatus.SUSPENDED });
      await kit.createUser({ email: 'c@example.org', role: Role.INSTRUCTOR, status: AccountStatus.INVITED, withPassword: false });

      for (const status of ['ACTIVE', 'SUSPENDED', 'INVITED']) {
        const res = await admin.get(`${INSTRUCTORS}?status=${status}`).expect(200);
        expect(res.body.total).toBe(1);
        expect(res.body.items[0].status).toBe(status);
      }
    });

    it('lists only instructors - never students or other admins', async () => {
      await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
      await kit.createUser({ email: 'second.admin@example.org', role: Role.ADMIN });
      await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });

      const res = await admin.get(INSTRUCTORS).expect(200);
      expect(res.body.items.map((i: { email: string }) => i.email)).toEqual(['teacher@example.org']);
    });

    it('sorts by last sign-in in either direction, with never-signed-in people always last', async () => {
      await kit.prisma.user.createMany({
        data: [
          { email: 'a@example.org', fullName: 'A', role: Role.INSTRUCTOR, status: AccountStatus.ACTIVE, passwordHash: kit.goodHash, lastLoginAt: new Date('2026-01-01') },
          { email: 'b@example.org', fullName: 'B', role: Role.INSTRUCTOR, status: AccountStatus.ACTIVE, passwordHash: kit.goodHash, lastLoginAt: new Date('2026-02-01') },
          { email: 'c@example.org', fullName: 'C', role: Role.INSTRUCTOR, status: AccountStatus.ACTIVE, passwordHash: kit.goodHash, lastLoginAt: null },
        ],
      });
      const names = async (dir: string) =>
        (await admin.get(`${INSTRUCTORS}?sortBy=lastLoginAt&sortDir=${dir}`).expect(200)).body.items.map(
          (i: { fullName: string }) => i.fullName,
        );

      expect(await names('desc')).toEqual(['B', 'A', 'C']);
      expect(await names('asc')).toEqual(['A', 'B', 'C']);
    });

    it('never exposes passwords, hashes or tokens', async () => {
      await createViaApi();
      await createActiveInstructor();
      const text = JSON.stringify((await admin.get(INSTRUCTORS).expect(200)).body).toLowerCase();
      for (const forbidden of ['hash', 'password', 'token']) expect(text).not.toContain(forbidden);
    });
  });

  // ------------------------------------------------------------------ detail

  describe('detail', () => {
    it('shows who created the instructor, and follows the invitation through its life', async () => {
      const id = await createViaApi();

      const pending = await admin.get(`${INSTRUCTORS}/${id}`).expect(200);
      expect(pending.body.instructor).toMatchObject({ id, status: 'INVITED', createdBy: { id: adminId, fullName: 'Ada Admin' } });
      expect(pending.body.invite.state).toBe('pending');
      const days = (new Date(pending.body.invite.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);

      await kit.prisma.authToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await admin.get(`${INSTRUCTORS}/${id}`).expect(200)).body.invite.state).toBe('expired');

      await admin.post(`${INSTRUCTORS}/${id}/resend-invite`).expect(200);
      expect((await admin.get(`${INSTRUCTORS}/${id}`).expect(200)).body.invite.state).toBe('pending');

      await acceptInvite(await kit.latestEmailToken('instructor-invite')).expect(200);
      const accepted = await admin.get(`${INSTRUCTORS}/${id}`).expect(200);
      expect(accepted.body.invite).toEqual({ state: 'accepted', expiresAt: null });
      expect(accepted.body.instructor.status).toBe('ACTIVE');
    });

    it('answers 404 for unknown ids and for people who are not instructors, and 400 for a malformed id', async () => {
      const student = await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });

      await admin.get(`${INSTRUCTORS}/${SOME_ID}`).expect(404);
      await admin.get(`${INSTRUCTORS}/${student.id}`).expect(404);
      await admin.get(`${INSTRUCTORS}/${adminId}`).expect(404);
      await admin.get(`${INSTRUCTORS}/not-a-uuid`).expect(400);
    });

    it('never exposes secrets', async () => {
      const id = await createViaApi();
      const text = JSON.stringify((await admin.get(`${INSTRUCTORS}/${id}`).expect(200)).body).toLowerCase();
      for (const forbidden of ['hash', 'password"', 'token', 'actionurl']) expect(text).not.toContain(forbidden);
    });
  });

  // ------------------------------------------------------------------ update

  describe('update', () => {
    it('renames an instructor and records the change', async () => {
      const id = await createViaApi();
      const res = await admin.patch(`${INSTRUCTORS}/${id}`).send({ fullName: '  Renamed Person ' }).expect(200);

      expect(res.body.instructor.fullName).toBe('Renamed Person');
      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'instructor.updated' } });
      expect(audit).toMatchObject({ actorId: adminId, entityId: id });
      expect(audit.metadata).toEqual({ changed: ['fullName'] });
    });

    it('does nothing (and records nothing) when the values are unchanged', async () => {
      const id = await createViaApi();
      await admin.patch(`${INSTRUCTORS}/${id}`).send({ fullName: 'New Teacher', email: 'new.teacher@example.org' }).expect(200);
      expect(await auditActions({ action: { startsWith: 'instructor.updated' } })).toEqual([]);
      expect(await kit.prisma.emailOutbox.count()).toBe(1); // no extra invite sent
    });

    it('changes the email while the invitation is pending: old link dies, new link goes to the new address', async () => {
      const id = await createViaApi('wrong.address@example.org');
      const oldToken = await kit.latestEmailToken('instructor-invite');

      await admin.patch(`${INSTRUCTORS}/${id}`).send({ email: 'Right.Address@Example.org' }).expect(200);

      expect((await kit.prisma.user.findUniqueOrThrow({ where: { id } })).email).toBe('right.address@example.org');

      const emails = await kit.prisma.emailOutbox.findMany({ orderBy: { createdAt: 'asc' } });
      expect(emails.map((e) => e.toEmail)).toEqual(['wrong.address@example.org', 'right.address@example.org']);

      await acceptInvite(oldToken).expect(400); // the link sent to the old address no longer works
      await acceptInvite(await kit.latestEmailToken('instructor-invite')).expect(200);

      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'instructor.email_changed' } });
      expect(audit.metadata).toMatchObject({
        previousEmail: 'wrong.address@example.org',
        newEmail: 'right.address@example.org',
      });
    });

    it('refuses an email change once the instructor is active, but still allows a rename', async () => {
      const active = await createActiveInstructor();

      const refused = await admin.patch(`${INSTRUCTORS}/${active.id}`).send({ email: 'new@example.org' }).expect(400);
      expect(refused.body.message).toContain('invitation is still pending');
      expect((await kit.prisma.user.findUniqueOrThrow({ where: { id: active.id } })).email).toBe('active.teacher@example.org');

      await admin.patch(`${INSTRUCTORS}/${active.id}`).send({ fullName: 'Better Name' }).expect(200);
    });

    it('refuses an email that already belongs to someone else, and changes nothing', async () => {
      const id = await createViaApi();
      await kit.createUser({ email: 'taken@example.org', role: Role.STUDENT });

      await admin.patch(`${INSTRUCTORS}/${id}`).send({ fullName: 'Should Not Stick', email: 'taken@example.org' }).expect(409);

      const user = await kit.prisma.user.findUniqueOrThrow({ where: { id } });
      expect(user).toMatchObject({ email: 'new.teacher@example.org', fullName: 'New Teacher' });
    });

    it('rejects an empty update, unknown fields and invalid values', async () => {
      const id = await createViaApi();
      await admin.patch(`${INSTRUCTORS}/${id}`).send({}).expect(400);
      await admin.patch(`${INSTRUCTORS}/${id}`).send({ role: 'ADMIN' }).expect(400);
      await admin.patch(`${INSTRUCTORS}/${id}`).send({ status: 'ACTIVE' }).expect(400);
      await admin.patch(`${INSTRUCTORS}/${id}`).send({ email: 'not-an-email' }).expect(400);
      await admin.patch(`${INSTRUCTORS}/${id}`).send({ fullName: 'A' }).expect(400);
    });

    it('cannot edit admins or students through this route', async () => {
      const student = await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
      await admin.patch(`${INSTRUCTORS}/${student.id}`).send({ fullName: 'Hacked Name' }).expect(404);
      await admin.patch(`${INSTRUCTORS}/${adminId}`).send({ fullName: 'Hacked Name' }).expect(404);
      expect((await kit.prisma.user.findUniqueOrThrow({ where: { id: student.id } })).fullName).toBe('Test Person');
    });
  });

  // ------------------------------------------------------------ resend invite

  describe('resend invite', () => {
    it('voids the old link, queues a new email, and the new link works', async () => {
      const id = await createViaApi();
      const oldToken = await kit.latestEmailToken('instructor-invite');

      await admin.post(`${INSTRUCTORS}/${id}/resend-invite`).expect(200);

      expect(await kit.prisma.emailOutbox.count()).toBe(2);
      await acceptInvite(oldToken).expect(400);
      await acceptInvite(await kit.latestEmailToken('instructor-invite')).expect(200);
      expect(await auditActions({ action: 'instructor.invite_resent' })).toHaveLength(1);
    });

    it('is refused for instructors who are not waiting on an invitation', async () => {
      const active = await createActiveInstructor();
      await admin.post(`${INSTRUCTORS}/${active.id}/resend-invite`).expect(409);

      const suspended = await kit.createUser({ email: 's@example.org', role: Role.INSTRUCTOR, status: AccountStatus.SUSPENDED });
      await admin.post(`${INSTRUCTORS}/${suspended.id}/resend-invite`).expect(409);
      expect(await kit.prisma.emailOutbox.count()).toBe(0);
    });
  });

  // ------------------------------------------------------ suspend & reactivate

  describe('suspend and reactivate', () => {
    it('suspending signs the instructor out of everything immediately and blocks sign-in', async () => {
      const teacher = await createActiveInstructor();
      const teacherBrowser = await kit.loginAgent('active.teacher@example.org', 'instructor');
      await teacherBrowser.get('/api/v1/auth/me').expect(200);

      const res = await admin.post(`${INSTRUCTORS}/${teacher.id}/suspend`).send({ reason: 'Policy breach - private note' }).expect(200);

      expect(res.body.instructor.status).toBe('SUSPENDED');
      expect(JSON.stringify(res.body)).not.toContain('Policy breach'); // the reason is for admins only

      await teacherBrowser.get('/api/v1/auth/me').expect(401); // very next click fails
      await request(kit.server())
        .post('/api/v1/auth/login')
        .send({ email: 'active.teacher@example.org', password: GOOD_PASSWORD, portal: 'instructor' })
        .expect(401);

      expect(await kit.prisma.session.count({ where: { userId: teacher.id, revokedAt: null } })).toBe(0);

      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'instructor.suspended' } });
      expect(audit).toMatchObject({ actorId: adminId, entityId: teacher.id });
      expect(audit.metadata).toEqual({ reason: 'Policy breach - private note' });
    });

    it('works without a reason (and without any request body)', async () => {
      const teacher = await createActiveInstructor();
      await admin.post(`${INSTRUCTORS}/${teacher.id}/suspend`).expect(200);
      expect((await kit.prisma.user.findUniqueOrThrow({ where: { id: teacher.id } })).status).toBe(AccountStatus.SUSPENDED);
    });

    it('rejects an over-long reason, and suspending someone twice', async () => {
      const teacher = await createActiveInstructor();
      await admin.post(`${INSTRUCTORS}/${teacher.id}/suspend`).send({ reason: 'x'.repeat(501) }).expect(400);
      await admin.post(`${INSTRUCTORS}/${teacher.id}/suspend`).expect(200);
      await admin.post(`${INSTRUCTORS}/${teacher.id}/suspend`).expect(409);
      expect(await auditActions({ action: 'instructor.suspended' })).toHaveLength(1);
    });

    it('reactivating restores an instructor who had a password to ACTIVE, with the same password', async () => {
      const teacher = await createActiveInstructor();
      await admin.post(`${INSTRUCTORS}/${teacher.id}/suspend`).expect(200);

      const res = await admin.post(`${INSTRUCTORS}/${teacher.id}/reactivate`).expect(200);

      expect(res.body.instructor.status).toBe('ACTIVE');
      await kit.loginAgent('active.teacher@example.org', 'instructor'); // signs in with the original password
      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'instructor.reactivated' } });
      expect(audit.metadata).toEqual({ restoredStatus: 'ACTIVE' });
    });

    it('reactivating someone who never set a password sends them back to INVITED with a fresh link', async () => {
      const id = await createViaApi();
      await admin.post(`${INSTRUCTORS}/${id}/suspend`).expect(200);

      const res = await admin.post(`${INSTRUCTORS}/${id}/reactivate`).expect(200);

      expect(res.body.instructor.status).toBe('INVITED');
      expect(await kit.prisma.emailOutbox.count()).toBe(2);
      await acceptInvite(await kit.latestEmailToken('instructor-invite')).expect(200);
      expect((await kit.prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe(AccountStatus.ACTIVE);
    });

    it('refuses to reactivate someone who is not suspended', async () => {
      const teacher = await createActiveInstructor();
      await admin.post(`${INSTRUCTORS}/${teacher.id}/reactivate`).expect(409);
    });

    it('cannot suspend or reactivate admins and students through this route', async () => {
      const student = await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });

      await admin.post(`${INSTRUCTORS}/${student.id}/suspend`).expect(404);
      await admin.post(`${INSTRUCTORS}/${adminId}/suspend`).expect(404); // an admin cannot lock themselves out here
      await admin.post(`${INSTRUCTORS}/${student.id}/reactivate`).expect(404);

      expect((await kit.prisma.user.findUniqueOrThrow({ where: { id: student.id } })).status).toBe(AccountStatus.ACTIVE);
      await admin.get('/api/v1/auth/me').expect(200);
    });
  });

  // -------------------------------------------------------------- audit trail

  describe('audit trail', () => {
    it('records every admin action, in order, with who did it', async () => {
      const id = await createViaApi();
      await admin.patch(`${INSTRUCTORS}/${id}`).send({ fullName: 'Renamed Person' }).expect(200);
      await admin.post(`${INSTRUCTORS}/${id}/resend-invite`).expect(200);
      await admin.post(`${INSTRUCTORS}/${id}/suspend`).expect(200);
      await admin.post(`${INSTRUCTORS}/${id}/reactivate`).expect(200);

      const rows = await kit.prisma.auditLog.findMany({
        where: { actorId: adminId, action: { startsWith: 'instructor.' } },
        orderBy: { createdAt: 'asc' },
      });

      expect(rows.map((r) => r.action)).toEqual([
        'instructor.created',
        'instructor.updated',
        'instructor.invite_resent',
        'instructor.suspended',
        'instructor.reactivated',
      ]);
      expect(rows.every((r) => r.entityId === id && r.entityType === 'user')).toBe(true);
    });
  });
});