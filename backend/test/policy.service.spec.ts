/**
 * policy.service.spec.ts
 * ---------------------------------------------------------------------------
 * The ownership-rule framework: deny by default, allow only what a registered
 * rule approves.
 */
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../src/auth/auth.types';
import { PolicyService } from '../src/auth/policy/policy.service';

const student: AuthenticatedUser = { id: 'u1', email: 's@x.org', fullName: 'S', role: Role.STUDENT };

describe('PolicyService', () => {
  it('denies an action nobody wrote a rule for (deny by default)', async () => {
    const policy = new PolicyService();
    expect(await policy.can(student, 'lesson.view', { courseId: 'c1' })).toBe(false);
    await expect(policy.assertCan(student, 'lesson.view')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows what a registered rule approves, and denies the rest', async () => {
    const policy = new PolicyService();
    // Example rule: a student may view lessons only in courses they are enrolled in.
    policy.register<{ courseId: string }>('lesson.view', (_user, lesson) => lesson.courseId === 'c1');

    expect(await policy.can(student, 'lesson.view', { courseId: 'c1' })).toBe(true);
    expect(await policy.can(student, 'lesson.view', { courseId: 'c2' })).toBe(false);
    await expect(policy.assertCan(student, 'lesson.view', { courseId: 'c1' })).resolves.toBeUndefined();
    await expect(policy.assertCan(student, 'lesson.view', { courseId: 'c2' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('supports rules that need to look something up (async)', async () => {
    const policy = new PolicyService();
    policy.register('cohort.manage', async (user) => user.role === Role.ADMIN);
    expect(await policy.can(student, 'cohort.manage')).toBe(false);
    expect(await policy.can({ ...student, role: Role.ADMIN }, 'cohort.manage')).toBe(true);
  });

  it('refuses to register the same action twice', () => {
    const policy = new PolicyService();
    policy.register('x', () => true);
    expect(() => policy.register('x', () => false)).toThrow(/already registered/);
  });
});