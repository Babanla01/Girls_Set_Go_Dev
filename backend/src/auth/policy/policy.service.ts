/**
 * policy.service.ts
 * ---------------------------------------------------------------------------
 * The framework for OWNERSHIP rules: questions beyond "what role are you?",
 * such as "is this student enrolled in THIS course?" or "is this instructor
 * assigned to THIS cohort?".
 *
 * How it works:
 *  - Each feature module registers a rule for an action when the app starts,
 *    e.g. policy.register('lesson.view', (user, lesson) => ...).
 *  - Routes call `assertCan(user, 'lesson.view', lesson)`.
 *  - DENY BY DEFAULT: an action nobody wrote a rule for is always refused.
 *
 * Batch 3 builds the framework; the real rules arrive with the data they need
 * (enrollments, cohorts) in later batches.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth.types';

export type PolicyRule<TResource = unknown> = (
  user: AuthenticatedUser,
  resource: TResource,
) => boolean | Promise<boolean>;

@Injectable()
export class PolicyService {
  private readonly rules = new Map<string, PolicyRule<never>>();

  /** Registers the rule for an action (call once, at startup). */
  register<TResource>(action: string, rule: PolicyRule<TResource>): void {
    if (this.rules.has(action)) {
      throw new Error(`A policy rule for "${action}" is already registered.`);
    }
    this.rules.set(action, rule as PolicyRule<never>);
  }

  /** Does the rule allow this? Unknown actions are never allowed. */
  async can<TResource>(user: AuthenticatedUser, action: string, resource?: TResource): Promise<boolean> {
    const rule = this.rules.get(action) as PolicyRule<TResource | undefined> | undefined;
    if (!rule) return false;
    return Boolean(await rule(user, resource));
  }

  /** Like `can`, but throws a 403 "forbidden" when the answer is no. */
  async assertCan<TResource>(user: AuthenticatedUser, action: string, resource?: TResource): Promise<void> {
    if (!(await this.can(user, action, resource))) {
      throw new ForbiddenException('You do not have permission to do that.');
    }
  }
}