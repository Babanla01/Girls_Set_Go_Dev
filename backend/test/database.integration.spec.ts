/**
 * database.integration.spec.ts
 * ---------------------------------------------------------------------------
 * Tests the database rules against a REAL PostgreSQL database (the "_test"
 * one). The idea: try to break every rule and prove the database says no.
 *
 * Run with:  npm run test:db   (needs Docker's Postgres running)
 *
 * Before each test every table is emptied, so tests never affect each other.
 * The guard in test-database-url.ts guarantees this only ever touches a
 * database whose name ends in "_test".
 */
import { Prisma, PrismaClient } from '@prisma/client';

import { getTestDatabaseUrl } from './helpers/test-database-url';

const prisma = new PrismaClient({ datasourceUrl: getTestDatabaseUrl(), log: [] });

// ------------------------------------------------------------ small helpers

const TABLES = 'users, sessions, auth_tokens, audit_logs, instructor_applications, email_outbox';

function makeAdmin(email = 'admin@example.org') {
  return prisma.user.create({
    data: { email, fullName: 'Admin', passwordHash: 'hash', role: 'ADMIN', status: 'ACTIVE' },
  });
}

/** A complete, valid instructor application (override any field per test). */
function applicationData(overrides: Partial<Prisma.InstructorApplicationCreateInput> = {}) {
  return {
    fullName: 'Ada Teacher',
    email: 'ada@example.org',
    phone: '08012345678',
    expertise: 'Robotics',
    bio: 'Short bio',
    experience: 'Five years teaching',
    links: ['https://github.com/ada'],
    motivation: 'I love teaching',
    availability: 'Weekends',
    ...overrides,
  };
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ------------------------------------------------------------------- users

describe('users', () => {
  it('creates an invited instructor without a password', async () => {
    const user = await prisma.user.create({
      data: { email: 'teach@example.org', fullName: 'Teacher', role: 'INSTRUCTOR', status: 'INVITED' },
    });
    expect(user.passwordHash).toBeNull();
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/); // random UUID
  });

  it('rejects a duplicate email', async () => {
    await makeAdmin('same@example.org');
    await expect(makeAdmin('same@example.org')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects an email that is not lowercase', async () => {
    await expect(makeAdmin('Mixed@Example.org')).rejects.toThrow();
  });

  it('rejects an ACTIVE account that has no password', async () => {
    await expect(
      prisma.user.create({
        data: { email: 'nopass@example.org', fullName: 'N', role: 'STUDENT', status: 'ACTIVE' },
      }),
    ).rejects.toThrow();
  });

  it('refuses to delete a user who has audit history', async () => {
    const admin = await makeAdmin();
    await prisma.auditLog.create({
      data: { actorId: admin.id, action: 'test.action', entityType: 'user', entityId: admin.id },
    });
    await expect(prisma.user.delete({ where: { id: admin.id } })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- sessions

describe('sessions', () => {
  it('are removed automatically when their user is removed', async () => {
    const student = await prisma.user.create({
      data: { email: 'stu@example.org', fullName: 'S', passwordHash: 'h', role: 'STUDENT', status: 'ACTIVE' },
    });
    await prisma.session.create({
      data: { userId: student.id, tokenHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000) },
    });

    await prisma.user.delete({ where: { id: student.id } });

    expect(await prisma.session.count()).toBe(0);
  });

  it('refuse a duplicate token hash', async () => {
    const admin = await makeAdmin();
    const data = { userId: admin.id, tokenHash: 'd'.repeat(64), expiresAt: new Date(Date.now() + 1000) };
    await prisma.session.create({ data });
    await expect(prisma.session.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });
});

// ------------------------------------------------------------- auth tokens

describe('auth tokens', () => {
  async function makeToken(expiresInMs: number) {
    const user = await prisma.user.create({
      data: { email: 'teach@example.org', fullName: 'T', role: 'INSTRUCTOR', status: 'INVITED' },
    });
    const tokenHash = 'a'.repeat(64);
    await prisma.authToken.create({
      data: { userId: user.id, type: 'INVITE', tokenHash, expiresAt: new Date(Date.now() + expiresInMs) },
    });
    return tokenHash;
  }

  // The pattern the login code will use: "claim" a token in ONE atomic step.
  const claim = (tokenHash: string) =>
    prisma.authToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });

  it('can be used once, and never again', async () => {
    const tokenHash = await makeToken(60_000);
    expect((await claim(tokenHash)).count).toBe(1); // first use succeeds
    expect((await claim(tokenHash)).count).toBe(0); // second use finds nothing
  });

  it('cannot be used after it has expired', async () => {
    const tokenHash = await makeToken(-1000); // already expired
    expect((await claim(tokenHash)).count).toBe(0);
  });

  it('refuses a duplicate token hash', async () => {
    const tokenHash = await makeToken(60_000);
    const user = await prisma.user.findFirstOrThrow();
    await expect(
      prisma.authToken.create({
        data: { userId: user.id, type: 'PASSWORD_RESET', tokenHash, expiresAt: new Date(Date.now() + 1000) },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

// --------------------------------------------------------------- audit log

describe('audit log', () => {
  it('accepts new entries', async () => {
    await prisma.auditLog.create({
      data: { action: 'system.started', entityType: 'system', metadata: { note: 'ok' } },
    });
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('cannot be edited', async () => {
    await prisma.auditLog.create({ data: { action: 'original', entityType: 'system' } });
    await expect(prisma.auditLog.updateMany({ data: { action: 'tampered' } })).rejects.toThrow();
  });

  it('cannot have entries deleted', async () => {
    await prisma.auditLog.create({ data: { action: 'original', entityType: 'system' } });
    await expect(prisma.auditLog.deleteMany()).rejects.toThrow();
    expect(await prisma.auditLog.count()).toBe(1);
  });
});

// ---------------------------------------------------- instructor applications

describe('instructor applications', () => {
  it('starts as pending with no reviewer', async () => {
    const app = await prisma.instructorApplication.create({ data: applicationData() });
    expect(app.status).toBe('PENDING');
    expect(app.reviewedAt).toBeNull();
  });

  it('allows only ONE pending application per email', async () => {
    await prisma.instructorApplication.create({ data: applicationData() });
    await expect(prisma.instructorApplication.create({ data: applicationData() })).rejects.toThrow();
  });

  it('allows a new application after the earlier one was decided', async () => {
    const first = await prisma.instructorApplication.create({ data: applicationData() });
    await prisma.instructorApplication.update({
      where: { id: first.id },
      data: { status: 'DECLINED', reviewedAt: new Date() },
    });
    const again = await prisma.instructorApplication.create({ data: applicationData() });
    expect(again.status).toBe('PENDING');
  });

  it('allows different people to have pending applications at the same time', async () => {
    await prisma.instructorApplication.create({ data: applicationData({ email: 'one@example.org' }) });
    await prisma.instructorApplication.create({ data: applicationData({ email: 'two@example.org' }) });
    expect(await prisma.instructorApplication.count()).toBe(2);
  });

  it('rejects a decided application that has no review date', async () => {
    await expect(
      prisma.instructorApplication.create({ data: applicationData({ status: 'DECLINED' }) }),
    ).rejects.toThrow();
  });

  it('rejects an approval that does not point at the created instructor account', async () => {
    await expect(
      prisma.instructorApplication.create({
        data: applicationData({ status: 'APPROVED', reviewedAt: new Date() }),
      }),
    ).rejects.toThrow();
  });

  it('accepts a proper approval linked to an instructor account', async () => {
    const admin = await makeAdmin();
    const teacher = await prisma.user.create({
      data: {
        email: 'ada@example.org',
        fullName: 'Ada',
        role: 'INSTRUCTOR',
        status: 'INVITED',
        createdById: admin.id,
      },
    });
    const app = await prisma.instructorApplication.create({
      data: applicationData({
        status: 'APPROVED',
        reviewedAt: new Date(),
        reviewedBy: { connect: { id: admin.id } },
        createdUser: { connect: { id: teacher.id } },
      }),
    });
    expect(app.createdUserId).toBe(teacher.id);
  });

  it('rejects more than 5 links', async () => {
    await expect(
      prisma.instructorApplication.create({
        data: applicationData({ links: ['1', '2', '3', '4', '5', '6'] }),
      }),
    ).rejects.toThrow();
  });

  it('rejects an email that is not lowercase', async () => {
    await expect(
      prisma.instructorApplication.create({ data: applicationData({ email: 'Ada@Example.org' }) }),
    ).rejects.toThrow();
  });
});

// ------------------------------------------------------------ email outbox

describe('email outbox', () => {
  it('queues a new email as pending with zero attempts', async () => {
    const row = await prisma.emailOutbox.create({
      data: { toEmail: 'x@example.org', template: 'instructor-invite', payload: { name: 'Ada' } },
    });
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(0);
  });
});

// ------------------------------------------------- one transaction, all or nothing

describe('transactions', () => {
  it('roll everything back when one step fails (nothing half-done)', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: { email: 'rollback@example.org', fullName: 'R', role: 'INSTRUCTOR', status: 'INVITED' },
        });
        await tx.emailOutbox.create({
          data: { toEmail: 'rollback@example.org', template: 'instructor-invite', payload: {} },
        });
        throw new Error('something went wrong after both inserts');
      }),
    ).rejects.toThrow('something went wrong');

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.emailOutbox.count()).toBe(0);
  });
});