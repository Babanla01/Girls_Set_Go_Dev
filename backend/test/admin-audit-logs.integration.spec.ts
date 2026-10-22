/**
 * admin-audit-logs.integration.spec.ts
 * ---------------------------------------------------------------------------
 * The admin-only, read-only audit log viewer, against the REAL app, PostgreSQL
 * and Redis.
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { Role } from '@prisma/client';
import request from 'supertest';

import { createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const AUDIT = '/api/v1/admin/audit-logs';

describe('Admin: audit log viewer (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;
  let adminId: string;
  let otherId: string;

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    adminId = (await kit.createUser({ email: 'admin@example.org', fullName: 'Ada Admin', role: Role.ADMIN })).id;
    otherId = (await kit.createUser({ email: 'other@example.org', fullName: 'Other Person', role: Role.INSTRUCTOR })).id;
    admin = await kit.loginAgent('admin@example.org', 'admin'); // this login writes its own audit entry
  });

  /** Entries tagged "seed" so tests can ignore the admin's own login entry. */
  async function seed() {
    await kit.prisma.auditLog.createMany({
      data: [
        { actorId: adminId, action: 'seed.one', entityType: 'seed', entityId: 'e1', metadata: { n: 1 }, createdAt: new Date('2026-10-01T10:00:00Z') },
        { actorId: null, action: 'seed.two', entityType: 'seed', entityId: 'e2', createdAt: new Date('2026-10-02T10:00:00Z') },
        { actorId: otherId, action: 'seed.one', entityType: 'seed', entityId: 'e3', createdAt: new Date('2026-10-03T10:00:00Z') },
        { actorId: adminId, action: 'seed.three', entityType: 'other', entityId: 'e1', createdAt: new Date('2026-10-04T10:00:00Z') },
      ],
    });
  }

  const actions = (res: { body: { items: Array<{ action: string }> } }) => res.body.items.map((i) => i.action);

  it('lists entries newest first, with who did it (or null for the system)', async () => {
    await seed();
    const res = await admin.get(`${AUDIT}?entityType=seed`).expect(200);

    expect(res.body.total).toBe(3);
    expect(res.body.items.map((i: { entityId: string }) => i.entityId)).toEqual(['e3', 'e2', 'e1']);
    expect(res.body.items[0].actor).toEqual({ id: otherId, fullName: 'Other Person', email: 'other@example.org' });
    expect(res.body.items[1].actor).toBeNull();
    expect(res.body.items[2]).toMatchObject({ metadata: { n: 1 }, action: 'seed.one' });
  });

  it('filters by action, person, subject and time range', async () => {
    await seed();

    expect(actions(await admin.get(`${AUDIT}?action=seed.one`).expect(200))).toEqual(['seed.one', 'seed.one']);
    expect((await admin.get(`${AUDIT}?actorId=${otherId}`).expect(200)).body.total).toBe(1);
    expect((await admin.get(`${AUDIT}?entityId=e1`).expect(200)).body.total).toBe(2);
    expect((await admin.get(`${AUDIT}?entityType=other`).expect(200)).body.total).toBe(1);

    const range = await admin.get(`${AUDIT}?entityType=seed&from=2026-10-02T00:00:00Z&to=2026-10-02T23:59:59Z`).expect(200);
    expect(range.body.items.map((i: { entityId: string }) => i.entityId)).toEqual(['e2']);

    const combined = await admin.get(`${AUDIT}?action=seed.one&actorId=${adminId}`).expect(200);
    expect(combined.body.total).toBe(1);
  });

  it('pages stably even when many entries share the same timestamp', async () => {
    const sameTime = new Date('2026-09-01T00:00:00Z');
    await kit.prisma.auditLog.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({ action: 'bulk.entry', entityType: 'bulk', entityId: String(i), createdAt: sameTime })),
    });

    const seen = new Set<string>();
    for (const page of [1, 2, 3]) {
      const res = await admin.get(`${AUDIT}?entityType=bulk&page=${page}&pageSize=10`).expect(200);
      expect(res.body).toMatchObject({ total: 30, totalPages: 3 });
      for (const item of res.body.items) seen.add(item.id);
    }
    expect(seen.size).toBe(30); // no entry skipped or repeated
  });

  it('rejects malformed filters and oversized pages', async () => {
    for (const query of [
      'actorId=not-a-uuid',
      'from=yesterday-ish',
      'to=not-a-date',
      'pageSize=101',
      'page=0',
      'unknown=1',
      `action=${'x'.repeat(101)}`,
    ]) {
      await admin.get(`${AUDIT}?${query}`).expect(400);
    }
  });

  it('shows what admins just did, including who did it', async () => {
    await admin.post('/api/v1/admin/instructors').send({ fullName: 'New Teacher', email: 'new.teacher@example.org' }).expect(201);

    const res = await admin.get(`${AUDIT}?action=instructor.created`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      action: 'instructor.created',
      actor: { id: adminId, fullName: 'Ada Admin' },
      metadata: { email: 'new.teacher@example.org' },
    });
  });

  it('never contains passwords or secrets, even after a failed sign-in attempt', async () => {
    await request(kit.server())
      .post('/api/v1/auth/login')
      .send({ email: 'someone@example.org', password: 'Wrong-Distinct-Pass-9!', portal: 'student' })
      .expect(401);

    const viaApi = JSON.stringify((await admin.get(`${AUDIT}?pageSize=100`).expect(200)).body).toLowerCase();
    const viaDatabase = JSON.stringify(await kit.prisma.auditLog.findMany()).toLowerCase();

    for (const text of [viaApi, viaDatabase]) {
      expect(text).not.toContain('wrong-distinct-pass');
      expect(text).not.toContain('sunny-garden');
      expect(text).not.toContain('passwordhash');
    }
  });

  it('is read-only: there is no way to add, change or delete entries through the API', async () => {
    await seed();
    const before = await kit.prisma.auditLog.count();

    await admin.post(AUDIT).send({ action: 'forged', entityType: 'x' }).expect(404);
    await admin.put(`${AUDIT}/${adminId}`).send({}).expect(404);
    await admin.patch(`${AUDIT}/${adminId}`).send({}).expect(404);
    await admin.delete(AUDIT).expect(404);
    await admin.delete(`${AUDIT}/${adminId}`).expect(404);

    expect(await kit.prisma.auditLog.count()).toBe(before);
  });
});