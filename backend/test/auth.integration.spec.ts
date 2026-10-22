/**
 * auth.integration.spec.ts
 * ---------------------------------------------------------------------------
 * End-to-end tests of authentication, using the REAL app, PostgreSQL and
 * Redis. Each test tries to break one rule and proves the app says no.
 *
 * Run with:  npm run test:db
 *
 * Before each test the tables and the test Redis database are emptied, so
 * tests never affect each other.
 */
import { TEST_APP_ORIGIN } from './helpers/integration-env'; // must stay first: sets the environment

import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountStatus, AuthTokenType, Role } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AdminBootstrapService } from '../src/auth/admin-bootstrap.service';
import { GENERIC_LOGIN_ERROR, INVALID_LINK_ERROR, Portal, RESET_REQUESTED_MESSAGE } from '../src/auth/auth.constants';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { CurrentUser } from '../src/auth/decorators/current-user.decorator';
import { Public } from '../src/auth/decorators/public.decorator';
import { Roles } from '../src/auth/decorators/roles.decorator';
import { LoginAttemptService } from '../src/auth/login-attempt.service';
import { PasswordService } from '../src/auth/password/password.service';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

// ------------------------------------------------------------ probe routes
// Tiny routes that exist ONLY in these tests, to prove the guards work.
@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }

  @Get('any') // no decorators: must still require sign-in (deny by default)
  any(@CurrentUser() user: AuthenticatedUser) {
    return { id: user.id };
  }

  @Roles(Role.ADMIN)
  @Get('admin')
  admin() {
    return { ok: true };
  }

  @Roles(Role.INSTRUCTOR, Role.ADMIN)
  @Get('staff')
  staff() {
    return { ok: true };
  }
}

// ------------------------------------------------------------------ set-up

const GOOD_PASSWORD = 'Sunny-Garden-42!';
const NEW_PASSWORD = 'Brand-New-Pass-77#';
const TABLES = 'users, sessions, auth_tokens, audit_logs, instructor_applications, email_outbox';

describe('Authentication (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let tokens: TokenService;
  let passwords: PasswordService;
  let goodHash: string;

  const server = () => app.getHttpServer();
  const agent = () => request.agent(server());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    tokens = app.get(TokenService);
    passwords = app.get(PasswordService);
    goodHash = await passwords.hash(GOOD_PASSWORD); // hashed once, reused by every test
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await redis.client.flushdb(); // test Redis database only (number 15)
  });

  // ----------------------------------------------------------------- helpers

  function createUser(
    overrides: Partial<{ email: string; role: Role; status: AccountStatus; withPassword: boolean }> = {},
  ) {
    const status = overrides.status ?? AccountStatus.ACTIVE;
    return prisma.user.create({
      data: {
        email: overrides.email ?? 'student@example.org',
        fullName: 'Test Person',
        role: overrides.role ?? Role.STUDENT,
        status,
        passwordHash: overrides.withPassword === false ? null : goodHash,
      },
    });
  }

  const login = (email: string, password: string, portal: Portal, via: { post: Function } = request(server())) =>
    via.post('/api/v1/auth/login').send({ email, password, portal });

  /** The raw session token from a login response's Set-Cookie header. */
  function sessionTokenFrom(res: request.Response): string {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith('gsg_session='));
    if (!cookie) throw new Error('No session cookie was set');
    return cookie.split(';')[0].split('=')[1];
  }

  /** The secret from the most recent emailed link of a given template. */
  async function latestEmailToken(template: string): Promise<string> {
    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { template }, orderBy: { createdAt: 'desc' } });
    const url = new URL((row.payload as { actionUrl: string }).actionUrl);
    return url.searchParams.get('token') as string;
  }

  const auditActions = async () => (await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map((r) => r.action);

  // ------------------------------------------------------------------- login

  describe('login', () => {
    it('signs a student in, sets a secure cookie, and never returns the password hash', async () => {
      await createUser();
      const res = await login('student@example.org', GOOD_PASSWORD, 'student').expect(200);

      expect(res.body.user).toMatchObject({ email: 'student@example.org', role: 'STUDENT' });
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain('hash');
      expect(JSON.stringify(res.body)).not.toContain(GOOD_PASSWORD);

      const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookie).toContain('HttpOnly'); // page scripts cannot read it
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
    });

    it('accepts email in any capitalisation, with stray spaces', async () => {
      await createUser();
      await login('  Student@Example.ORG ', GOOD_PASSWORD, 'student').expect(200);
    });

    it('stores only a hash of the session token in the database', async () => {
      await createUser();
      const res = await login('student@example.org', GOOD_PASSWORD, 'student').expect(200);
      const token = sessionTokenFrom(res);

      const row = await prisma.session.findFirstOrThrow();
      expect(row.tokenHash).not.toBe(token);
      expect(row.tokenHash).toHaveLength(64);
      expect(row.tokenHash).toBe(tokens.hash(token));
    });

    it('makes EVERY kind of failed login look identical', async () => {
      await createUser({ email: 'student@example.org' });
      await createUser({ email: 'invited@example.org', role: Role.INSTRUCTOR, status: AccountStatus.INVITED, withPassword: false });
      await createUser({ email: 'suspended@example.org', status: AccountStatus.SUSPENDED });

      // Each attempt is wrapped in a function so it only starts when we run it.
      const attempts = [
        () => login('student@example.org', 'Wrong-Password-1!', 'student'), //   wrong password
        () => login('nobody@example.org', GOOD_PASSWORD, 'student'), //          unknown email
        () => login('student@example.org', GOOD_PASSWORD, 'admin'), //           right password, wrong door
        () => login('invited@example.org', GOOD_PASSWORD, 'instructor'), //      invited, not active yet
        () => login('suspended@example.org', GOOD_PASSWORD, 'student'), //       suspended
      ];
      const results: request.Response[] = [];
      for (const attempt of attempts) results.push(await attempt()); // one at a time

      for (const res of results) {
        expect(res.status).toBe(401);
        expect(res.body.message).toBe(GENERIC_LOGIN_ERROR);
        expect(res.headers['set-cookie']).toBeUndefined();
      }

      // ...but the REAL reasons are recorded privately for admins.
      const reasons = (await prisma.auditLog.findMany({ where: { action: 'auth.login_failed' } })).map(
        (row) => (row.metadata as { reason: string }).reason,
      );
      expect(reasons).toEqual(
        expect.arrayContaining(['bad_password', 'unknown_email', 'wrong_portal', 'account_suspended']),
      );
    });

    it('rejects malformed requests before touching the database', async () => {
      const base = { email: 'student@example.org', password: GOOD_PASSWORD, portal: 'student' };
      await request(server()).post('/api/v1/auth/login').send({ ...base, isAdmin: true }).expect(400); // extra field
      await request(server()).post('/api/v1/auth/login').send({ ...base, portal: 'superuser' }).expect(400);
      await request(server()).post('/api/v1/auth/login').send({ ...base, email: 'not-an-email' }).expect(400);
      await request(server()).post('/api/v1/auth/login').send({ email: base.email, portal: 'student' }).expect(400);
      await request(server()).post('/api/v1/auth/login').send({ ...base, password: 'x'.repeat(129) }).expect(400);
    });

    it('never writes passwords into the audit log', async () => {
      await createUser();
      await login('student@example.org', 'SuperSecret-Wrong-77!', 'student').expect(401);
      await login('student@example.org', GOOD_PASSWORD, 'student').expect(200);

      const everything = JSON.stringify(await prisma.auditLog.findMany());
      expect(everything).not.toContain('SuperSecret-Wrong-77!');
      expect(everything).not.toContain(GOOD_PASSWORD);
      expect(await auditActions()).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.login']));
    });
  });

  // ------------------------------------------------- sessions & permissions

  describe('sessions and permissions', () => {
    it('GET /auth/me tells a signed-in person who they are', async () => {
      await createUser();
      const browser = agent();
      await login('student@example.org', GOOD_PASSWORD, 'student', browser).expect(200);

      const me = await browser.get('/api/v1/auth/me').expect(200);
      expect(me.body.user).toMatchObject({ email: 'student@example.org', role: 'STUDENT' });
    });

    it('locks every route by default (no cookie = 401), except the ones marked public', async () => {
      await request(server()).get('/api/v1/auth/me').expect(401);
      await request(server()).get('/api/v1/probe/any').expect(401); // no decorators at all
      await request(server()).get('/api/v1/probe/admin').expect(401); // not 403: they are not signed in
      await request(server()).get('/api/v1/probe/open').expect(200); // @Public
    });

    it('enforces roles: each role reaches only its own routes', async () => {
      await createUser({ email: 'student@example.org', role: Role.STUDENT });
      await createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
      await createUser({ email: 'admin@example.org', role: Role.ADMIN });

      const student = agent();
      const teacher = agent();
      const admin = agent();
      await login('student@example.org', GOOD_PASSWORD, 'student', student).expect(200);
      await login('teacher@example.org', GOOD_PASSWORD, 'instructor', teacher).expect(200);
      await login('admin@example.org', GOOD_PASSWORD, 'admin', admin).expect(200);

      await student.get('/api/v1/probe/any').expect(200);
      await student.get('/api/v1/probe/admin').expect(403);
      await student.get('/api/v1/probe/staff').expect(403);

      await teacher.get('/api/v1/probe/staff').expect(200);
      await teacher.get('/api/v1/probe/admin').expect(403);

      await admin.get('/api/v1/probe/admin').expect(200);
      await admin.get('/api/v1/probe/staff').expect(200);
    });

    it('logout ends the session on the SERVER (a copied cookie stops working)', async () => {
      await createUser();
      const browser = agent();
      const res = await login('student@example.org', GOOD_PASSWORD, 'student', browser).expect(200);
      const token = sessionTokenFrom(res);

      await browser.post('/api/v1/auth/logout').expect(204);

      await request(server()).get('/api/v1/auth/me').set('Cookie', `gsg_session=${token}`).expect(401);
      expect(await auditActions()).toContain('auth.logout');
    });

    it('cuts off a SUSPENDED user immediately, even mid-session', async () => {
      const user = await createUser();
      const browser = agent();
      await login('student@example.org', GOOD_PASSWORD, 'student', browser).expect(200);
      await browser.get('/api/v1/auth/me').expect(200);

      await prisma.user.update({ where: { id: user.id }, data: { status: AccountStatus.SUSPENDED } });

      await browser.get('/api/v1/auth/me').expect(401);
    });

    it('ends a session after 7 days without activity', async () => {
      await createUser();
      const browser = agent();
      await login('student@example.org', GOOD_PASSWORD, 'student', browser).expect(200);

      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
      await prisma.session.updateMany({ data: { lastUsedAt: eightDaysAgo } });

      await browser.get('/api/v1/auth/me').expect(401);
    });

    it('ends a session after 30 days no matter what', async () => {
      await createUser();
      const browser = agent();
      await login('student@example.org', GOOD_PASSWORD, 'student', browser).expect(200);

      await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      await browser.get('/api/v1/auth/me').expect(401);
    });

    it('keeps a session that was used within 7 days, and records the activity', async () => {
      await createUser();
      const browser = agent();
      await login('student@example.org', GOOD_PASSWORD, 'student', browser).expect(200);

      const sixDaysAgo = new Date(Date.now() - 6 * 24 * 3600 * 1000);
      await prisma.session.updateMany({ data: { lastUsedAt: sixDaysAgo } });

      await browser.get('/api/v1/auth/me').expect(200);

      const session = await prisma.session.findFirstOrThrow();
      expect(Date.now() - session.lastUsedAt.getTime()).toBeLessThan(60_000); // refreshed to "now"
    });

    it('rejects garbage and oversized cookies', async () => {
      await request(server()).get('/api/v1/auth/me').set('Cookie', 'gsg_session=not-a-real-token').expect(401);
      await request(server()).get('/api/v1/auth/me').set('Cookie', `gsg_session=${'a'.repeat(500)}`).expect(401);
    });
  });

  // -------------------------------------------------------- guessing defence

  describe('protection against guessing', () => {
    it('rate-limits login: the 6th rapid attempt gets 429', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await login('someone@example.org', 'Wrong-Password-1!', 'student')).status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it('pauses logins for an email after 5 wrong passwords - even with the RIGHT password', async () => {
      await createUser();
      const attempts = app.get(LoginAttemptService);

      expect(await attempts.isBlocked('student@example.org')).toBe(false);
      for (let i = 0; i < 4; i++) await attempts.recordFailure('student@example.org');
      expect(await attempts.isBlocked('student@example.org')).toBe(false); // 4 is still fine
      await attempts.recordFailure('student@example.org'); // the 5th
      expect(await attempts.isBlocked('student@example.org')).toBe(true);

      const blocked = await login('student@example.org', GOOD_PASSWORD, 'student').expect(429);
      expect(blocked.body.message).toContain('15 minutes');
      expect(await auditActions()).toContain('auth.login_blocked');

      await attempts.reset('student@example.org'); // pause over
      await login('student@example.org', GOOD_PASSWORD, 'student').expect(200);
    });

    it('applies the pause to unknown emails too, so it reveals nothing', async () => {
      const attempts = app.get(LoginAttemptService);
      for (let i = 0; i < 5; i++) await attempts.recordFailure('ghost@example.org');
      const res = await login('ghost@example.org', GOOD_PASSWORD, 'student').expect(429);
      expect(res.body.message).toContain('15 minutes');
    });

    it('forgets earlier mistakes after a successful login', async () => {
      await createUser();
      const attempts = app.get(LoginAttemptService);
      for (let i = 0; i < 3; i++) await attempts.recordFailure('student@example.org');

      await login('student@example.org', GOOD_PASSWORD, 'student').expect(200);

      for (let i = 0; i < 4; i++) await attempts.recordFailure('student@example.org');
      expect(await attempts.isBlocked('student@example.org')).toBe(false); // counter started from zero
    });

    it('refuses state-changing requests that come from another website (CSRF)', async () => {
      await createUser();
      await request(server())
        .post('/api/v1/auth/login')
        .set('Origin', 'https://evil.example')
        .send({ email: 'student@example.org', password: GOOD_PASSWORD, portal: 'student' })
        .expect(403);

      // A forged logout from another site must not end a real session either.
      const browser = agent();
      await login('student@example.org', GOOD_PASSWORD, 'student', browser).expect(200);
      await browser.post('/api/v1/auth/logout').set('Origin', 'https://evil.example').expect(403);
      await browser.get('/api/v1/auth/me').expect(200); // still signed in

      // Requests from our own website work normally.
      await request(server())
        .post('/api/v1/auth/login')
        .set('Origin', TEST_APP_ORIGIN)
        .send({ email: 'student@example.org', password: GOOD_PASSWORD, portal: 'student' })
        .expect(200);
    });
  });

  // ---------------------------------------------------------- forgot password

  describe('forgot password', () => {
    const ask = (email: string) => request(server()).post('/api/v1/auth/forgot-password').send({ email });

    it('answers the same, and takes about as long, whether or not the email exists', async () => {
      await createUser();

      const startedKnown = Date.now();
      const known = await ask('student@example.org').expect(200);
      const knownMs = Date.now() - startedKnown;

      const startedUnknown = Date.now();
      const unknown = await ask('nobody@example.org').expect(200);
      const unknownMs = Date.now() - startedUnknown;

      expect(known.body).toEqual({ message: RESET_REQUESTED_MESSAGE });
      expect(unknown.body).toEqual({ message: RESET_REQUESTED_MESSAGE });
      expect(knownMs).toBeGreaterThanOrEqual(200); // padded to a minimum time
      expect(unknownMs).toBeGreaterThanOrEqual(200);
    });

    it('queues exactly one email for a real account, and none for unknown, invited or suspended ones', async () => {
      await createUser({ email: 'student@example.org' });
      await createUser({ email: 'invited@example.org', status: AccountStatus.INVITED, withPassword: false });
      await createUser({ email: 'suspended@example.org', status: AccountStatus.SUSPENDED });

      await ask('nobody@example.org');
      await ask('invited@example.org');
      await ask('suspended@example.org');
      expect(await prisma.emailOutbox.count()).toBe(0);

      await ask('student@example.org');
      const rows = await prisma.emailOutbox.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ toEmail: 'student@example.org', template: 'password-reset', status: 'PENDING' });
      expect((rows[0].payload as { actionUrl: string }).actionUrl).toContain(`${TEST_APP_ORIGIN}/reset-password?token=`);
    });

    it('stores only a hash of the link secret', async () => {
      await createUser();
      await ask('student@example.org');
      const token = await latestEmailToken('password-reset');
      const row = await prisma.authToken.findFirstOrThrow();

      expect(row.tokenHash).not.toBe(token);
      expect(row.tokenHash).toBe(tokens.hash(token));
      expect(row.type).toBe(AuthTokenType.PASSWORD_RESET);
    });
  });

  // ----------------------------------------------------------- reset password

  describe('reset password', () => {
    const reset = (token: string, newPassword: string) =>
      request(server()).post('/api/v1/auth/reset-password').send({ token, newPassword });

    async function requestLink(email = 'student@example.org') {
      await request(server()).post('/api/v1/auth/forgot-password').send({ email });
      return latestEmailToken('password-reset');
    }

    it('rejects a weak password with a clear list of problems, and keeps the link usable', async () => {
      await createUser();
      const token = await requestLink();

      const weak = await reset(token, 'short').expect(400);
      expect(weak.body.message).toEqual(expect.arrayContaining([expect.stringContaining('at least 10')]));

      await reset(token, NEW_PASSWORD).expect(200); // the same link still works
    });

    it('sets the new password, retires the old one, and signs the user out everywhere', async () => {
      await createUser();
      const oldSession = agent();
      await login('student@example.org', GOOD_PASSWORD, 'student', oldSession).expect(200);
      await oldSession.get('/api/v1/auth/me').expect(200);

      const token = await requestLink();
      await reset(token, NEW_PASSWORD).expect(200);

      await oldSession.get('/api/v1/auth/me').expect(401); // other devices are signed out
      await login('student@example.org', GOOD_PASSWORD, 'student').expect(401); // old password dead
      await login('student@example.org', NEW_PASSWORD, 'student').expect(200); // new one works
      expect(await auditActions()).toContain('auth.password_reset_completed');
    });

    it('works only once', async () => {
      await createUser();
      const token = await requestLink();
      await reset(token, NEW_PASSWORD).expect(200);

      const again = await reset(token, 'Another-Pass-88$').expect(400);
      expect(again.body.message).toBe(INVALID_LINK_ERROR);
    });

    it('cannot be used twice even when two requests arrive at the same instant', async () => {
      await createUser();
      const token = await requestLink();

      const [a, b] = await Promise.all([reset(token, NEW_PASSWORD), reset(token, 'Another-Pass-88$')]);

      expect([a.status, b.status].sort()).toEqual([200, 400]); // exactly one wins
    });

    it('does not work after it has expired', async () => {
      await createUser();
      const token = await requestLink();
      await prisma.authToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      await reset(token, NEW_PASSWORD).expect(400);
    });

    it('a newer link voids the older one', async () => {
      await createUser();
      const first = await requestLink();
      const second = await requestLink();

      await reset(first, NEW_PASSWORD).expect(400);
      await reset(second, NEW_PASSWORD).expect(200);
    });

    it('rejects an invented link, and an invite link used as a reset link', async () => {
      const user = await createUser();
      await reset('x'.repeat(43), NEW_PASSWORD).expect(400);

      const inviteToken = await tokens.issue(user.id, AuthTokenType.INVITE);
      await reset(inviteToken, NEW_PASSWORD).expect(400);
    });
  });

  // ------------------------------------------------------------ accept invite

  describe('accept invite', () => {
    const accept = (token: string, newPassword: string) =>
      request(server()).post('/api/v1/auth/accept-invite').send({ token, newPassword });

    async function invitedInstructor() {
      const user = await createUser({
        email: 'new.teacher@example.org',
        role: Role.INSTRUCTOR,
        status: AccountStatus.INVITED,
        withPassword: false,
      });
      const token = await tokens.issue(user.id, AuthTokenType.INVITE);
      return { user, token };
    }

    it('lets an invited instructor choose a password, and only then sign in', async () => {
      const { user, token } = await invitedInstructor();

      await login('new.teacher@example.org', NEW_PASSWORD, 'instructor').expect(401); // not yet

      await accept(token, 'weakpass').expect(400);
      await accept(token, NEW_PASSWORD).expect(200);

      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.status).toBe(AccountStatus.ACTIVE);
      expect(updated.passwordHash).toMatch(/^\$argon2id\$/);

      const res = await login('new.teacher@example.org', NEW_PASSWORD, 'instructor').expect(200);
      expect(res.body.user.role).toBe('INSTRUCTOR');
      expect(await auditActions()).toContain('auth.invite_accepted');
    });

    it('works only once', async () => {
      const { token } = await invitedInstructor();
      await accept(token, NEW_PASSWORD).expect(200);
      await accept(token, 'Another-Pass-88$').expect(400);
    });

    it('does not work after it has expired', async () => {
      const { token } = await invitedInstructor();
      await prisma.authToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      await accept(token, NEW_PASSWORD).expect(400);
    });

    it('cannot be used to change the password of an account that is already active', async () => {
      const active = await createUser();
      const token = await tokens.issue(active.id, AuthTokenType.INVITE);

      await accept(token, NEW_PASSWORD).expect(400);
      await login('student@example.org', GOOD_PASSWORD, 'student').expect(200); // password unchanged
    });
  });

  // --------------------------------------------------------- first admin tool

  describe('first admin command', () => {
    it('creates an invited admin and a one-time link that completes the account', async () => {
      const bootstrap = app.get(AdminBootstrapService);
      const { link } = await bootstrap.createAdminInvite({ email: ' First.Admin@Example.org ', fullName: 'First Admin' });

      const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'first.admin@example.org' } });
      expect(admin).toMatchObject({ role: Role.ADMIN, status: AccountStatus.INVITED, passwordHash: null, createdById: null });
      expect(link.startsWith(`${TEST_APP_ORIGIN}/set-password?token=`)).toBe(true);

      const token = new URL(link).searchParams.get('token') as string;
      await request(server()).post('/api/v1/auth/accept-invite').send({ token, newPassword: NEW_PASSWORD }).expect(200);

      const res = await login('first.admin@example.org', NEW_PASSWORD, 'admin').expect(200);
      expect(res.body.user.role).toBe('ADMIN');
      expect(await auditActions()).toContain('admin.created_via_command_line');
    });

    it('refuses duplicates and bad input', async () => {
      const bootstrap = app.get(AdminBootstrapService);
      await bootstrap.createAdminInvite({ email: 'admin@example.org', fullName: 'Admin One' });

      await expect(bootstrap.createAdminInvite({ email: 'ADMIN@example.org', fullName: 'Again' })).rejects.toThrow(/already exists/);
      await expect(bootstrap.createAdminInvite({ email: 'nope', fullName: 'Admin Two' })).rejects.toThrow(/valid email/);
      await expect(bootstrap.createAdminInvite({ email: 'ok@example.org', fullName: 'A' })).rejects.toThrow(/name/);
    });

    it('cannot be done from the website: no public route creates an admin', async () => {
      await request(server())
        .post('/api/v1/auth/accept-invite')
        .send({ token: 'x'.repeat(43), newPassword: NEW_PASSWORD, role: 'ADMIN' })
        .expect(400); // unknown field "role" is rejected outright
      expect(await prisma.user.count({ where: { role: Role.ADMIN } })).toBe(0);
    });
  });
});