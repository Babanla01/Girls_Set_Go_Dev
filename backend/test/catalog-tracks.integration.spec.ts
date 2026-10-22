/**
 * catalog-tracks.integration.spec.ts
 * ---------------------------------------------------------------------------
 * Admin: tracks, plus the starter-tracks seed - against the REAL app,
 * PostgreSQL and Redis. Each test tries to break a rule.
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { Role, TrackStatus } from '@prisma/client';
import request from 'supertest';

import { seedTracks } from '../src/catalog/seed-tracks';
import { AuditService } from '../src/common/audit/audit.service';
import { makeCourse, makeTrack } from './helpers/catalog-helpers';
import { createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const TRACKS = '/api/v1/admin/tracks';
const SOME_ID = '11111111-1111-4111-8111-111111111111';

describe('Admin: tracks (integration)', () => {
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
    adminId = (await kit.createUser({ email: 'admin@example.org', fullName: 'Ada Admin', role: Role.ADMIN })).id;
    admin = await kit.loginAgent('admin@example.org', 'admin');
  });

  const auditActions = async (where = {}) =>
    (await kit.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } })).map((row) => row.action);

  // ---------------------------------------------------- who may use these routes

  describe('who may use these routes', () => {
    const routes: Array<['get' | 'post' | 'patch', string]> = [
      ['post', TRACKS],
      ['get', TRACKS],
      ['get', `${TRACKS}/${SOME_ID}`],
      ['patch', `${TRACKS}/${SOME_ID}`],
      ['post', `${TRACKS}/${SOME_ID}/archive`],
      ['post', `${TRACKS}/${SOME_ID}/restore`],
    ];

    it('refuses signed-out visitors with 401 and students/instructors with 403', async () => {
      await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
      await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
      const student = await kit.loginAgent('student@example.org', 'student');
      const teacher = await kit.loginAgent('teacher@example.org', 'instructor');

      for (const [method, url] of routes) {
        await request(kit.server())[method](url).send({}).expect(401);
        await student[method](url).send({}).expect(403);
        await teacher[method](url).send({}).expect(403);
      }
      expect(await kit.prisma.track.count()).toBe(0);
    });
  });

  // ------------------------------------------------------------------ create

  describe('create', () => {
    it('creates an active track, with a lowercase key, a clean name and an audit entry', async () => {
      const res = await admin.post(TRACKS).send({ name: '  AI   &  Robotics ', description: '  Machine learning and robots.  ' }).expect(201);

      expect(res.body.track).toMatchObject({
        name: 'AI & Robotics',
        description: 'Machine learning and robots.',
        status: 'ACTIVE',
        activeCourseCount: 0,
      });

      const row = await kit.prisma.track.findFirstOrThrow();
      expect(row).toMatchObject({ nameKey: 'ai & robotics', createdById: adminId });

      const audit = await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'track.created' } });
      expect(audit).toMatchObject({ actorId: adminId, entityType: 'track', entityId: row.id });
    });

    it('treats an empty description as no description', async () => {
      await admin.post(TRACKS).send({ name: 'Plain Track', description: '   ' }).expect(201);
      expect((await kit.prisma.track.findFirstOrThrow()).description).toBeNull();
    });

    it('refuses a duplicate name, ignoring capitals and extra spaces', async () => {
      await admin.post(TRACKS).send({ name: 'AI & Robotics' }).expect(201);

      const res = await admin.post(TRACKS).send({ name: '  ai   &  ROBOTICS ' }).expect(409);
      expect(res.body.message).toContain('already exists');
      expect(await kit.prisma.track.count()).toBe(1);
    });

    it('lets exactly one of two simultaneous creations win', async () => {
      const [a, b] = await Promise.all([
        admin.post(TRACKS).send({ name: 'Race Track' }),
        admin.post(TRACKS).send({ name: 'RACE track' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await kit.prisma.track.count()).toBe(1);
    });

    it('rejects bad input, and will not let a client choose the status', async () => {
      for (const body of [
        {},
        { name: 'A' },
        { name: 'x'.repeat(101) },
        { name: 'Valid Name', status: 'ARCHIVED' },
        { name: 'Valid Name', description: 'x'.repeat(2001) },
        { name: 'Valid Name', createdById: SOME_ID },
      ]) {
        await admin.post(TRACKS).send(body).expect(400);
      }
      expect(await kit.prisma.track.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------- list

  describe('list and detail', () => {
    it('lists tracks with paging, search, status filter and sorting', async () => {
      await makeTrack(admin, 'Zebra Studies');
      await makeTrack(admin, 'Alpha Robotics');
      const archivedId = await makeTrack(admin, 'Old Track');
      await admin.post(`${TRACKS}/${archivedId}/archive`).expect(200);

      const all = await admin.get(TRACKS).expect(200);
      expect(all.body).toMatchObject({ total: 3, page: 1, pageSize: 20, totalPages: 1 });
      expect(all.body.items.map((t: { name: string }) => t.name)).toEqual(['Alpha Robotics', 'Old Track', 'Zebra Studies']); // name, ascending

      expect((await admin.get(`${TRACKS}?sortBy=name&sortDir=desc`).expect(200)).body.items[0].name).toBe('Zebra Studies');
      expect((await admin.get(`${TRACKS}?search=ROBOT`).expect(200)).body.items.map((t: { name: string }) => t.name)).toEqual(['Alpha Robotics']);
      expect((await admin.get(`${TRACKS}?status=ARCHIVED`).expect(200)).body.items.map((t: { name: string }) => t.name)).toEqual(['Old Track']);
      expect((await admin.get(`${TRACKS}?pageSize=2&page=2`).expect(200)).body.items).toHaveLength(1);
    });

    it('rejects bad list parameters', async () => {
      for (const query of ['pageSize=101', 'page=0', 'status=NOPE', 'sortBy=nameKey', 'sortDir=sideways', 'foo=bar']) {
        await admin.get(`${TRACKS}?${query}`).expect(400);
      }
    });

    it('shows one track, with the number of courses still in use', async () => {
      const trackId = await makeTrack(admin);
      await makeCourse(admin, trackId, 'Course A');
      const archivedCourse = await makeCourse(admin, trackId, 'Course B');
      await admin.post(`/api/v1/admin/courses/${archivedCourse}/archive`).expect(200);

      const res = await admin.get(`${TRACKS}/${trackId}`).expect(200);
      expect(res.body.track).toMatchObject({ id: trackId, activeCourseCount: 1 }); // archived ones do not count
    });

    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      await admin.get(`${TRACKS}/${SOME_ID}`).expect(404);
      await admin.get(`${TRACKS}/not-a-uuid`).expect(400);
    });
  });

  // ------------------------------------------------------------------ update

  describe('update', () => {
    it('renames, changes and clears the description, and audits what changed', async () => {
      const id = await makeTrack(admin, 'Old Name');

      const renamed = await admin.patch(`${TRACKS}/${id}`).send({ name: '  New   Name ' }).expect(200);
      expect(renamed.body.track.name).toBe('New Name');
      expect((await kit.prisma.track.findUniqueOrThrow({ where: { id } })).nameKey).toBe('new name'); // key follows

      await admin.patch(`${TRACKS}/${id}`).send({ description: 'Now with words' }).expect(200);
      const cleared = await admin.patch(`${TRACKS}/${id}`).send({ description: '' }).expect(200);
      expect(cleared.body.track.description).toBeNull();

      const audits = await kit.prisma.auditLog.findMany({ where: { action: 'track.updated' }, orderBy: { createdAt: 'asc' } });
      expect(audits.map((a) => a.metadata)).toEqual([{ changed: ['name'] }, { changed: ['description'] }, { changed: ['description'] }]);
    });

    it('does nothing, and records nothing, when the values are unchanged', async () => {
      const id = await makeTrack(admin, 'Same Name');
      await admin.patch(`${TRACKS}/${id}`).send({ name: 'Same   Name' }).expect(200);
      expect(await auditActions({ action: 'track.updated' })).toEqual([]);
    });

    it('refuses a name that belongs to another track, and changes nothing', async () => {
      await makeTrack(admin, 'Taken Name');
      const id = await makeTrack(admin, 'My Track');

      await admin.patch(`${TRACKS}/${id}`).send({ name: 'TAKEN name' }).expect(409);
      expect((await kit.prisma.track.findUniqueOrThrow({ where: { id } })).name).toBe('My Track');
    });

    it('rejects an empty update and unknown or forbidden fields', async () => {
      const id = await makeTrack(admin);
      await admin.patch(`${TRACKS}/${id}`).send({}).expect(400);
      await admin.patch(`${TRACKS}/${id}`).send({ status: 'ARCHIVED' }).expect(400); // status changes only via archive/restore
      await admin.patch(`${TRACKS}/${id}`).send({ name: 'A' }).expect(400);
      await admin.patch(`${TRACKS}/${SOME_ID}`).send({ name: 'Ghost Track' }).expect(404);
    });
  });

  // -------------------------------------------------------- archive / restore

  describe('archive and restore', () => {
    it('archives and restores, auditing both', async () => {
      const id = await makeTrack(admin);

      expect((await admin.post(`${TRACKS}/${id}/archive`).expect(200)).body.track.status).toBe('ARCHIVED');
      expect((await admin.post(`${TRACKS}/${id}/restore`).expect(200)).body.track.status).toBe('ACTIVE');
      expect(await auditActions({ action: { in: ['track.archived', 'track.restored'] } })).toEqual(['track.archived', 'track.restored']);
    });

    it('refuses to archive twice, or to restore something that is not archived', async () => {
      const id = await makeTrack(admin);
      await admin.post(`${TRACKS}/${id}/restore`).expect(409);
      await admin.post(`${TRACKS}/${id}/archive`).expect(200);
      await admin.post(`${TRACKS}/${id}/archive`).expect(409);
    });

    it('refuses to archive while the track still has active courses, and says how many', async () => {
      const id = await makeTrack(admin);
      const courseA = await makeCourse(admin, id, 'Course A');
      await makeCourse(admin, id, 'Course B');

      const blocked = await admin.post(`${TRACKS}/${id}/archive`).expect(409);
      expect(blocked.body.message).toContain('2 active courses');
      expect((await kit.prisma.track.findUniqueOrThrow({ where: { id } })).status).toBe(TrackStatus.ACTIVE);

      await admin.post(`/api/v1/admin/courses/${courseA}/archive`).expect(200);
      expect((await admin.post(`${TRACKS}/${id}/archive`).expect(409)).body.message).toContain('1 active course.');
    });

    it('allows archiving once every course has been archived', async () => {
      const id = await makeTrack(admin);
      const course = await makeCourse(admin, id);
      await admin.post(`/api/v1/admin/courses/${course}/archive`).expect(200);
      await admin.post(`${TRACKS}/${id}/archive`).expect(200);
    });

    it('refuses new courses in an archived track', async () => {
      const id = await makeTrack(admin);
      await admin.post(`${TRACKS}/${id}/archive`).expect(200);

      const res = await admin.post('/api/v1/admin/courses').send({ trackId: id, title: 'Late Course' }).expect(409);
      expect(res.body.message).toContain('archived track');
    });

    it('never ends up with an archived track holding an active course, even when both happen at the same instant', async () => {
      for (let round = 0; round < 6; round++) {
        const id = await makeTrack(admin, `Race Track ${round}`);

        await Promise.all([
          admin.post(`${TRACKS}/${id}/archive`),
          admin.post('/api/v1/admin/courses').send({ trackId: id, title: `Race Course ${round}` }),
        ]);

        const track = await kit.prisma.track.findUniqueOrThrow({ where: { id } });
        const activeCourses = await kit.prisma.course.count({ where: { trackId: id, status: { not: 'ARCHIVED' } } });
        expect(track.status === TrackStatus.ARCHIVED && activeCourses > 0).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------- seed

  describe('starter tracks (db:seed)', () => {
    const run = () => seedTracks(kit.prisma, kit.app.get(AuditService));

    it('creates the two starter tracks', async () => {
      const result = await run();

      expect(result).toEqual({ created: ['AI & Robotics', 'UI/UX Design'], existing: [] });
      const names = (await kit.prisma.track.findMany({ orderBy: { name: 'asc' } })).map((t) => t.name);
      expect(names).toEqual(['AI & Robotics', 'UI/UX Design']);
      expect(await auditActions({ action: 'track.seeded' })).toHaveLength(2);
      expect((await kit.prisma.auditLog.findFirstOrThrow({ where: { action: 'track.seeded' } })).actorId).toBeNull(); // the system did it
    });

    it('is safe to run again: no duplicates, no extra audit entries', async () => {
      await run();
      const again = await run();

      expect(again).toEqual({ created: [], existing: ['AI & Robotics', 'UI/UX Design'] });
      expect(await kit.prisma.track.count()).toBe(2);
      expect(await auditActions({ action: 'track.seeded' })).toHaveLength(2);
    });

    it('leaves a track alone when one with the same name already exists (any capitals)', async () => {
      await makeTrack(admin, 'ai & ROBOTICS');
      const result = await run();

      expect(result.created).toEqual(['UI/UX Design']);
      expect(result.existing).toEqual(['AI & Robotics']);
      expect(await kit.prisma.track.count()).toBe(2);
    });

    it('survives two seeds running at the same time', async () => {
      await Promise.all([run(), run()]);
      expect(await kit.prisma.track.count()).toBe(2);
    });
  });
});