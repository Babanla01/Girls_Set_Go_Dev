/**
 * students-database.integration.spec.ts
 * ---------------------------------------------------------------------------
 * The database's OWN rules for student profiles, applications and
 * enrollments - tested by going straight to the database, so they hold even
 * if application code has a bug. (These are the rules written by hand in the
 * Batch 6 migration, plus the unique keys and delete protections.)
 *
 * Run with:  npm run test:db
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { Prisma, Role } from '@prisma/client';

import { createTestKit, TestKit } from './helpers/test-kit';

const SOME_ID = '11111111-1111-4111-8111-111111111111';

const daysFromNow = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

describe('Students, applications and enrollments: database rules (integration)', () => {
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

  // ----------------------------------------------------------------- helpers

  const student = (email: string) => kit.createUser({ email, role: Role.STUDENT });

  const profile = (userId: string, over: Partial<Prisma.StudentProfileUncheckedCreateInput> = {}) =>
    kit.prisma.studentProfile.create({
      data: {
        userId,
        dateOfBirth: new Date('2008-10-24'),
        phone: '08012345678',
        location: 'Lagos',
        schoolName: 'Government College',
        gradeLevel: 'SS2',
        ...over,
      },
    });

  const application = (studentId: string, over: Partial<Prisma.StudentApplicationUncheckedCreateInput> = {}) =>
    kit.prisma.studentApplication.create({
      data: {
        studentId,
        whyJoin: 'Because I love code.',
        hopeToLearn: 'How robots work.',
        consentAcceptedAt: new Date(),
        consentVersion: 'v1',
        ...over,
      },
    });

  const enrollment = (studentId: string, cohortId: string, over: Partial<Prisma.EnrollmentUncheckedCreateInput> = {}) =>
    kit.prisma.enrollment.create({ data: { studentId, cohortId, ...over } });

  const track = (name = 'AI & Robotics') => kit.prisma.track.create({ data: { name, nameKey: name.toLowerCase() } });
  const course = (trackId: string, title = 'Intro') =>
    kit.prisma.course.create({ data: { trackId, title, titleKey: title.toLowerCase() } });
  const cohort = (courseId: string, name = 'Cohort 1') =>
    kit.prisma.cohort.create({
      data: { courseId, name, nameKey: name.toLowerCase(), startsOn: new Date('2030-01-01'), endsOn: new Date('2030-06-01') },
    });

  /** A track, a course and a cohort. */
  const stack = async () => {
    const t = await track();
    const c = await course(t.id);
    const co = await cohort(c.id);
    return { trackId: t.id, courseId: c.id, cohortId: co.id };
  };

  const guardian = { guardianName: 'Mrs Okoye', guardianEmail: 'mum@example.org', guardianPhone: '08098765432' };

  // ---------------------------------------------------------- student profiles

  describe('student profiles', () => {
    it('accept a normal profile and the oldest date of birth allowed', async () => {
      const a = await student('a@example.org');
      const b = await student('b@example.org');

      await expect(profile(a.id)).resolves.toBeDefined();
      await expect(profile(b.id, { dateOfBirth: new Date('1900-01-01') })).resolves.toBeDefined();
    });

    it('forbid a date of birth in the future or before 1900', async () => {
      const a = await student('a@example.org');

      await expect(profile(a.id, { dateOfBirth: daysFromNow(3) })).rejects.toThrow();
      await expect(profile(a.id, { dateOfBirth: new Date('1899-12-31') })).rejects.toThrow();
      expect(await kit.prisma.studentProfile.count()).toBe(0);
    });

    it('forbid guardian details that are only partly filled in', async () => {
      const a = await student('a@example.org');

      await expect(profile(a.id, { guardianName: 'Mrs Okoye' })).rejects.toThrow();
      await expect(profile(a.id, { guardianName: 'Mrs Okoye', guardianEmail: 'mum@example.org' })).rejects.toThrow();
      await expect(profile(a.id, { guardianPhone: '08098765432' })).rejects.toThrow();
      expect(await kit.prisma.studentProfile.count()).toBe(0);
    });

    it('allow guardian details when all three are given, or none at all', async () => {
      const a = await student('a@example.org');
      const b = await student('b@example.org');

      await expect(profile(a.id, guardian)).resolves.toBeDefined();
      await expect(profile(b.id)).resolves.toBeDefined();
    });

    it('forbid a guardian email with capital letters', async () => {
      const a = await student('a@example.org');

      await expect(profile(a.id, { ...guardian, guardianEmail: 'Mum@Example.org' })).rejects.toThrow();
      expect(await kit.prisma.studentProfile.count()).toBe(0);
    });

    it('allow only one profile per student', async () => {
      const a = await student('a@example.org');
      await profile(a.id);

      await expect(profile(a.id)).rejects.toMatchObject({ code: 'P2002' });
    });

    it('belong to STUDENT accounts only', async () => {
      const teacher = await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
      const admin = await kit.createUser({ email: 'admin@example.org', role: Role.ADMIN });

      await expect(profile(teacher.id)).rejects.toThrow();
      await expect(profile(admin.id)).rejects.toThrow();
      expect(await kit.prisma.studentProfile.count()).toBe(0);
    });

    it('are deleted together with the account when nothing else depends on the student', async () => {
      const a = await student('a@example.org');
      await profile(a.id);

      await kit.prisma.user.delete({ where: { id: a.id } });

      expect(await kit.prisma.studentProfile.count()).toBe(0);
    });
  });

  // ------------------------------------------------------------- applications

  describe('applications', () => {
    it('start PENDING with nobody having reviewed them', async () => {
      const a = await student('a@example.org');

      const created = await application(a.id);

      expect(created).toMatchObject({ status: 'PENDING', reviewedAt: null, reviewedById: null, decisionNote: null });
      expect(created.submittedAt).toBeInstanceOf(Date);
    });

    it('allow only one application per student', async () => {
      const a = await student('a@example.org');
      await application(a.id);

      await expect(application(a.id)).rejects.toMatchObject({ code: 'P2002' });
    });

    it('belong to STUDENT accounts only, even when moved later', async () => {
      const teacher = await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });
      const a = await student('a@example.org');
      const mine = await application(a.id);

      await expect(application(teacher.id)).rejects.toThrow();
      await expect(
        kit.prisma.studentApplication.update({ where: { id: mine.id }, data: { studentId: teacher.id } }),
      ).rejects.toThrow();

      expect((await kit.prisma.studentApplication.findUniqueOrThrow({ where: { id: mine.id } })).studentId).toBe(a.id);
    });

    it('are PENDING exactly when nobody has decided them', async () => {
      const reviewer = await kit.createUser({ email: 'admin@example.org', role: Role.ADMIN });
      const a = await student('a@example.org');
      const b = await student('b@example.org');
      const c = await student('c@example.org');
      const now = new Date();

      // A decision must record who decided and when...
      await expect(application(a.id, { status: 'ACCEPTED' })).rejects.toThrow();
      await expect(application(a.id, { status: 'DECLINED', reviewedAt: now })).rejects.toThrow();
      await expect(application(a.id, { status: 'DECLINED', reviewedById: reviewer.id })).rejects.toThrow();
      // ...and a pending one cannot already have a reviewer.
      await expect(application(a.id, { reviewedAt: now, reviewedById: reviewer.id })).rejects.toThrow();
      expect(await kit.prisma.studentApplication.count()).toBe(0);

      await expect(application(b.id, { status: 'ACCEPTED', reviewedAt: now, reviewedById: reviewer.id })).resolves.toBeDefined();
      await expect(application(c.id, { status: 'DECLINED', reviewedAt: now, reviewedById: reviewer.id })).resolves.toBeDefined();
    });

    it('cannot be left half-decided by an update', async () => {
      const reviewer = await kit.createUser({ email: 'admin@example.org', role: Role.ADMIN });
      const a = await student('a@example.org');
      const mine = await application(a.id);
      const update = (data: Prisma.StudentApplicationUncheckedUpdateInput) =>
        kit.prisma.studentApplication.update({ where: { id: mine.id }, data });

      await expect(update({ status: 'ACCEPTED' })).rejects.toThrow();
      await expect(update({ reviewedAt: new Date() })).rejects.toThrow();
      await expect(update({ status: 'ACCEPTED', reviewedAt: new Date(), reviewedById: reviewer.id })).resolves.toBeDefined();

      // Going back to pending must clear the decision too.
      await expect(update({ status: 'PENDING' })).rejects.toThrow();
      await expect(update({ status: 'PENDING', reviewedAt: null, reviewedById: null })).resolves.toBeDefined();
    });

    it('may leave the preferred track empty (it is only a preference)', async () => {
      const a = await student('a@example.org');

      await expect(application(a.id, { preferredTrackId: null })).resolves.toMatchObject({ preferredTrackId: null });
    });

    it('must point at a track that really exists', async () => {
      const a = await student('a@example.org');

      await expect(application(a.id, { preferredTrackId: SOME_ID })).rejects.toMatchObject({ code: 'P2003' });
    });

    it('limit each answer to 2000 characters', async () => {
      const a = await student('a@example.org');
      const b = await student('b@example.org');

      await expect(application(a.id, { whyJoin: 'x'.repeat(2001) })).rejects.toThrow();
      await expect(application(b.id, { whyJoin: 'x'.repeat(2000) })).resolves.toBeDefined();
    });

    it('protect a track that a student prefers from being deleted', async () => {
      const t = await track();
      const a = await student('a@example.org');
      await application(a.id, { preferredTrackId: t.id });

      await expect(kit.prisma.track.delete({ where: { id: t.id } })).rejects.toMatchObject({ code: 'P2003' });
    });

    it('protect a student who has applied from being deleted', async () => {
      const a = await student('a@example.org');
      await application(a.id);

      await expect(kit.prisma.user.delete({ where: { id: a.id } })).rejects.toMatchObject({ code: 'P2003' });
      expect(await kit.prisma.user.count({ where: { id: a.id } })).toBe(1);
    });

    it('protect an admin who decided one from being deleted', async () => {
      const reviewer = await kit.createUser({ email: 'admin@example.org', role: Role.ADMIN });
      const a = await student('a@example.org');
      await application(a.id, { status: 'DECLINED', reviewedAt: new Date(), reviewedById: reviewer.id });

      await expect(kit.prisma.user.delete({ where: { id: reviewer.id } })).rejects.toMatchObject({ code: 'P2003' });
    });
  });

  // -------------------------------------------------------------- enrollments

  describe('enrollments', () => {
    it('allow only one ACTIVE enrollment per student, in any cohort', async () => {
      const { courseId, cohortId } = await stack();
      const other = await cohort(courseId, 'Other Cohort');
      const a = await student('a@example.org');
      await enrollment(a.id, cohortId);

      await expect(enrollment(a.id, other.id)).rejects.toMatchObject({ code: 'P2002' });
      await expect(enrollment(a.id, cohortId)).rejects.toMatchObject({ code: 'P2002' });
      expect(await kit.prisma.enrollment.count()).toBe(1);
    });

    it('allow a new ACTIVE enrollment once the old one has ended, and keep the history', async () => {
      const { courseId, cohortId } = await stack();
      const other = await cohort(courseId, 'Other Cohort');
      const a = await student('a@example.org');
      const first = await enrollment(a.id, cohortId);

      await kit.prisma.enrollment.update({ where: { id: first.id }, data: { status: 'TRANSFERRED', endedAt: new Date() } });

      await expect(enrollment(a.id, other.id)).resolves.toBeDefined();
      expect(await kit.prisma.enrollment.count({ where: { studentId: a.id } })).toBe(2);
      expect(await kit.prisma.enrollment.count({ where: { studentId: a.id, status: 'ACTIVE' } })).toBe(1);
    });

    it('allow many different students in one cohort', async () => {
      const { cohortId } = await stack();
      const a = await student('a@example.org');
      const b = await student('b@example.org');

      await expect(enrollment(a.id, cohortId)).resolves.toBeDefined();
      await expect(enrollment(b.id, cohortId)).resolves.toBeDefined();
    });

    it('are ACTIVE exactly while they have no end date', async () => {
      const { cohortId } = await stack();
      const a = await student('a@example.org');

      await expect(enrollment(a.id, cohortId, { endedAt: new Date() })).rejects.toThrow(); // active but ended
      await expect(enrollment(a.id, cohortId, { status: 'WITHDRAWN' })).rejects.toThrow(); // ended but no date
      await expect(enrollment(a.id, cohortId, { status: 'TRANSFERRED' })).rejects.toThrow();
      expect(await kit.prisma.enrollment.count()).toBe(0);

      await expect(enrollment(a.id, cohortId, { status: 'WITHDRAWN', endedAt: new Date() })).resolves.toBeDefined();
      await expect(enrollment(a.id, cohortId, { status: 'TRANSFERRED', endedAt: new Date() })).resolves.toBeDefined();
    });

    it('cannot be ended, or brought back, without keeping that rule', async () => {
      const { cohortId } = await stack();
      const a = await student('a@example.org');
      const current = await enrollment(a.id, cohortId);
      const update = (data: Prisma.EnrollmentUncheckedUpdateInput) =>
        kit.prisma.enrollment.update({ where: { id: current.id }, data });

      await expect(update({ status: 'WITHDRAWN' })).rejects.toThrow(); // needs an end date
      await expect(update({ status: 'WITHDRAWN', endedAt: new Date() })).resolves.toBeDefined();

      await expect(update({ status: 'ACTIVE' })).rejects.toThrow(); // still has the end date
      await expect(update({ status: 'ACTIVE', endedAt: null })).resolves.toBeDefined();
    });

    it('belong to STUDENT accounts only', async () => {
      const { cohortId } = await stack();
      const teacher = await kit.createUser({ email: 'teacher@example.org', role: Role.INSTRUCTOR });

      await expect(enrollment(teacher.id, cohortId)).rejects.toThrow();
      expect(await kit.prisma.enrollment.count()).toBe(0);
    });

    it('need a real cohort and a real student', async () => {
      const { cohortId } = await stack();
      const a = await student('a@example.org');

      await expect(enrollment(a.id, SOME_ID)).rejects.toMatchObject({ code: 'P2003' });
      await expect(enrollment(SOME_ID, cohortId)).rejects.toThrow();
    });

    it('allow only one enrollment per application', async () => {
      const { cohortId } = await stack();
      const a = await student('a@example.org');
      const mine = await application(a.id);
      await enrollment(a.id, cohortId, { applicationId: mine.id });

      await expect(
        enrollment(a.id, cohortId, { applicationId: mine.id, status: 'TRANSFERRED', endedAt: new Date() }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('protect the history: a cohort, a student or an application with an enrollment cannot be deleted', async () => {
      const { cohortId } = await stack();
      const a = await student('a@example.org');
      const b = await student('b@example.org');
      const bApplication = await application(b.id);
      await enrollment(a.id, cohortId);
      await enrollment(b.id, cohortId, { applicationId: bApplication.id });

      await expect(kit.prisma.cohort.delete({ where: { id: cohortId } })).rejects.toMatchObject({ code: 'P2003' });
      await expect(kit.prisma.user.delete({ where: { id: a.id } })).rejects.toMatchObject({ code: 'P2003' });
      await expect(kit.prisma.studentApplication.delete({ where: { id: bApplication.id } })).rejects.toMatchObject({
        code: 'P2003',
      });
      expect(await kit.prisma.enrollment.count()).toBe(2);
    });
  });
});