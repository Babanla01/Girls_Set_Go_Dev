/**
 * catalog-database.integration.spec.ts
 * ---------------------------------------------------------------------------
 * The database's OWN rules for tracks, courses and cohorts - tested by going
 * straight to the database, so they hold even if application code has a bug.
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { AccountStatus, Role } from '@prisma/client';

import { createTestKit, TestKit } from './helpers/test-kit';

describe('Tracks, courses and cohorts: database rules (integration)', () => {
  let kit: TestKit;

  beforeAll(async () => {
    kit = await createTestKit();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(async () => {
    await kit.reset();
  });

  const track = (name = 'AI & Robotics', nameKey = name.toLowerCase()) => kit.prisma.track.create({ data: { name, nameKey } });
  const course = (trackId: string, title = 'Intro', titleKey = title.toLowerCase()) =>
    kit.prisma.course.create({ data: { trackId, title, titleKey } });
  const cohort = (courseId: string, over: Record<string, unknown> = {}) =>
    kit.prisma.cohort.create({
      data: { courseId, name: 'Cohort 1', nameKey: 'cohort 1', startsOn: new Date('2030-01-01'), endsOn: new Date('2030-06-01'), ...over },
    });

  describe('tracks', () => {
    it('forbids two tracks whose names differ only by capitals', async () => {
      await track('AI & Robotics', 'ai & robotics');
      await expect(track('ai & ROBOTICS', 'ai & robotics')).rejects.toMatchObject({ code: 'P2002' });
    });

    it('forbids a lowercase key that does not match the name, and blank names', async () => {
      await expect(track('Real Name', 'something else')).rejects.toThrow();
      await expect(track('   ', '   ')).rejects.toThrow();
    });
  });

  describe('courses', () => {
    it('forbids a duplicate title inside one track, but allows it in another', async () => {
      const a = await track('Track A');
      const b = await track('Track B');
      await course(a.id, 'Intro');
      await expect(course(a.id, 'INTRO', 'intro')).rejects.toMatchObject({ code: 'P2002' });
      await expect(course(b.id, 'Intro')).resolves.toBeDefined();
    });

    it('forbids a course without a real track', async () => {
      await expect(kit.prisma.course.create({ data: { trackId: '11111111-1111-4111-8111-111111111111', title: 'X', titleKey: 'x' } })).rejects.toThrow();
    });

    it('forbids a mismatched key and a blank title', async () => {
      const t = await track();
      await expect(course(t.id, 'Real Title', 'different')).rejects.toThrow();
      await expect(course(t.id, '  ', '  ')).rejects.toThrow();
    });
  });

  describe('cohorts', () => {
    it('forbids a cohort that ends before it starts, but allows a one-day cohort', async () => {
      const c = await course((await track()).id);
      await expect(cohort(c.id, { name: 'Bad', nameKey: 'bad', startsOn: new Date('2030-06-02'), endsOn: new Date('2030-06-01') })).rejects.toThrow();
      await expect(cohort(c.id, { name: 'One day', nameKey: 'one day', startsOn: new Date('2030-06-01'), endsOn: new Date('2030-06-01') })).resolves.toBeDefined();
    });

    it('forbids silly capacities', async () => {
      const c = await course((await track()).id);
      for (const capacity of [0, -5, 10_001]) {
        await expect(cohort(c.id, { name: `Cap ${capacity}`, nameKey: `cap ${capacity}`, capacity })).rejects.toThrow();
      }
      await expect(cohort(c.id, { capacity: 10_000 })).resolves.toBeDefined();
    });

    it('forbids a duplicate name inside one course, but allows it in another', async () => {
      const t = await track();
      const c1 = await course(t.id, 'One');
      const c2 = await course(t.id, 'Two');
      await cohort(c1.id);
      await expect(cohort(c1.id, { name: 'COHORT 1' })).rejects.toMatchObject({ code: 'P2002' });
      await expect(cohort(c2.id)).resolves.toBeDefined();
    });
  });

  describe('teaching assignments', () => {
    const person = (role: Role, email: string) =>
      kit.prisma.user.create({ data: { email, fullName: email, role, status: AccountStatus.ACTIVE, passwordHash: kit.goodHash } });

    it('accepts an instructor, and refuses students and admins - at the database level', async () => {
      const c = await cohort((await course((await track()).id)).id);
      const teacher = await person(Role.INSTRUCTOR, 't@example.org');
      const student = await person(Role.STUDENT, 's@example.org');
      const admin = await person(Role.ADMIN, 'a@example.org');

      await expect(kit.prisma.cohortInstructor.create({ data: { cohortId: c.id, instructorId: teacher.id } })).resolves.toBeDefined();
      await expect(kit.prisma.cohortInstructor.create({ data: { cohortId: c.id, instructorId: student.id } })).rejects.toThrow();
      await expect(kit.prisma.cohortInstructor.create({ data: { cohortId: c.id, instructorId: admin.id } })).rejects.toThrow();
    });

    it('forbids assigning the same instructor to the same cohort twice', async () => {
      const c = await cohort((await course((await track()).id)).id);
      const teacher = await person(Role.INSTRUCTOR, 't@example.org');
      await kit.prisma.cohortInstructor.create({ data: { cohortId: c.id, instructorId: teacher.id } });
      await expect(kit.prisma.cohortInstructor.create({ data: { cohortId: c.id, instructorId: teacher.id } })).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('nothing in use can be deleted', () => {
    it('blocks deleting a track with courses, a course with cohorts, a cohort with instructors, and an instructor who teaches', async () => {
      const t = await track();
      const c = await course(t.id);
      const co = await cohort(c.id);
      const teacher = await kit.prisma.user.create({
        data: { email: 't@example.org', fullName: 'T', role: Role.INSTRUCTOR, status: AccountStatus.ACTIVE, passwordHash: kit.goodHash },
      });
      await kit.prisma.cohortInstructor.create({ data: { cohortId: co.id, instructorId: teacher.id } });

      await expect(kit.prisma.track.delete({ where: { id: t.id } })).rejects.toThrow();
      await expect(kit.prisma.course.delete({ where: { id: c.id } })).rejects.toThrow();
      await expect(kit.prisma.cohort.delete({ where: { id: co.id } })).rejects.toThrow();
      await expect(kit.prisma.user.delete({ where: { id: teacher.id } })).rejects.toThrow();
    });
  });
});