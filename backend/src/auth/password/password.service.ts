/**
 * password.service.ts
 * ---------------------------------------------------------------------------
 * Hashing and checking passwords with Argon2id.
 *
 * Plain-English notes:
 *  - We never store passwords - only a "hash": a one-way, deliberately slow
 *    fingerprint. Even with the database, an attacker cannot read passwords
 *    and must guess them one slow attempt at a time.
 *  - Settings follow current OWASP guidance for Argon2id (19 MiB memory,
 *    2 passes, 1 lane): strong, yet quick enough (~tens of milliseconds).
 *  - When someone logs in with an email that does not exist, we still do a
 *    full hash check against a throw-away hash. That way "unknown email" takes
 *    the same time as "wrong password" and nobody can probe for accounts.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

import { checkPasswordPolicy } from './password-policy';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB (~19 MiB)
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    // A hash of random text, used only to equalise timing for unknown emails.
    this.dummyHash = await argon2.hash(randomBytes(16).toString('hex'), ARGON2_OPTIONS);
  }

  /**
   * Returns a list of plain-English problems; empty means the password is fine.
   * Pass the person's email when you have it, so "password = email" is refused.
   */
  validatePolicy(password: string, email?: string): string[] {
    return checkPasswordPolicy(password, email);
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * Checks a password. Pass `null` when there is no stored hash (unknown
   * email, or an invited user who has not set a password): the check still
   * takes the normal amount of time and then returns false.
   */
  async verify(hash: string | null, password: string): Promise<boolean> {
    if (!hash) {
      await argon2.verify(this.dummyHash, password).catch(() => false);
      return false;
    }

    try {
      return await argon2.verify(hash, password);
    } catch {
      return false; // a malformed stored hash never counts as a match
    }
  }

  /** True when a stored hash uses older/weaker settings and should be upgraded at next login. */
  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  }
}