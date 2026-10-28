/**
 * public-tracks.integration.spec.ts
 * ---------------------------------------------------------------------------
 * GET /api/v1/public/tracks - the list of tracks a visitor can pick from on
 * the signup form. No sign-in needed; only ACTIVE tracks; only the id, name
 * and description. Real app, PostgreSQL and Redis (the TEST ones).
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { Role } from '@prisma/client';
import request from 'supertest';

import { GOOD_PASSWORD, createTestKit, TestAgent, TestKit } from './helpers/test-kit';

const PUBLIC_TRACKS = '/api/v1/public/tracks';
const ADMIN_TRACKS = '/api/v1/admin/tracks';

const said = (res: { body: unknown }) => JSON.stringify(res.body);

describe('Public tracks (integration)', () => {
  let kit: TestKit;
  let admin: TestAgent;

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
    await kit.createUser({ email: 'admin@example.org', fullName: 'Pat Admin', role: Role.ADMIN });
    admin = await kit.loginAgent('admin@example.org', 'admin');
  });

  const createTrack = async (name: string, description?: string): Promise<string> => {
    const res = await admin
      .post(ADMIN_TRACKS)
      .send({ name, ...(description ? { description } : {}) })
      .expect(201);
    return res.body.track.id as string;
  };

  const publicList = () => request(kit.server()).get(PUBLIC_TRACKS);

  it('is open to everyone and is simply empty when there are no tracks', async () => {
    const res = await publicList().expect(200);
    expect(res.body).toEqual({ tracks: [] });
  });

  it('lists the active tracks by name, with only an id, a name and a description', async () => {
    const webId = await createTrack('Web Development');
    const aiId = await createTrack('AI & Robotics', 'Build smart machines.');

    const res = await publicList().expect(200);

    expect(res.body.tracks).toEqual([
      { id: aiId, name: 'AI & Robotics', description: 'Build smart machines.' },
      { id: webId, name: 'Web Development', description: null },
    ]);
  });

  it('exposes nothing else about the system', async () => {
    await createTrack('AI & Robotics', 'Build smart machines.');

    const body = said(await publicList().expect(200));

    for (const hidden of ['nameKey', 'status', 'createdAt', 'updatedAt', 'createdBy', 'courses', 'Pat Admin']) {
      expect(body).not.toContain(hidden);
    }
  });

  it('hides an archived track, and shows it again when it is restored', async () => {
    const keptId = await createTrack('Web Development');
    const goneId = await createTrack('AI & Robotics');

    const archived = await admin.post(`${ADMIN_TRACKS}/${goneId}/archive`);
    expect(archived.status).toBeLessThan(300);

    const hidden = await publicList().expect(200);
    expect(hidden.body.tracks.map((t: { id: string }) => t.id)).toEqual([keptId]);

    const restored = await admin.post(`${ADMIN_TRACKS}/${goneId}/restore`);
    expect(restored.status).toBeLessThan(300);

    const shown = await publicList().expect(200);
    expect(shown.body.tracks.map((t: { id: string }) => t.id)).toEqual([goneId, keptId]);
  });

  it('gives a signed-in student the same list', async () => {
    const id = await createTrack('AI & Robotics');
    await kit.createUser({ email: 'student@example.org', role: Role.STUDENT });
    const student = await kit.loginAgent('student@example.org', 'student');

    const res = await student.get(PUBLIC_TRACKS).expect(200);
    expect(res.body.tracks.map((t: { id: string }) => t.id)).toEqual([id]);
  });

  it('only offers ids that signup accepts', async () => {
    await createTrack('AI & Robotics');
    const [offered] = (await publicList().expect(200)).body.tracks as Array<{ id: string }>;

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
        preferredTrackId: offered.id,
        whyJoin: 'I love building things with code.',
        hopeToLearn: 'How robots and AI really work.',
        password: GOOD_PASSWORD,
        confirmPassword: GOOD_PASSWORD,
        acceptTerms: true,
        acceptPrivacy: true,
      })
      .expect(201);
  });

  it('cannot be written to: it only answers reads', async () => {
    await request(kit.server()).post(PUBLIC_TRACKS).send({ name: 'Sneaky Track' }).expect(404);
    await request(kit.server()).delete(PUBLIC_TRACKS).expect(404);
  });
});