/**
 * login-attempt.service.ts
 * ---------------------------------------------------------------------------
 * The "too many wrong passwords" pause, kept in Redis.
 *
 * Rule: after 5 wrong passwords for an email, logins for that email pause for
 * 15 minutes. It is a PAUSE, not a permanent lock - otherwise anyone could
 * lock a real user out forever just by guessing wrong on purpose.
 *
 * It counts by email whether or not the account exists, so the pause itself
 * never reveals which emails are registered. The email is hashed in the key,
 * so no personal data sits in Redis.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { RedisService } from '../redis/redis.service';
import { LOGIN_MAX_FAILURES, LOGIN_PAUSE_SECONDS } from './auth.constants';

@Injectable()
export class LoginAttemptService {
  constructor(private readonly redis: RedisService) {}

  private key(email: string): string {
    return `login:fail:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
  }

  /** True while logins for this email are paused. */
  async isBlocked(email: string): Promise<boolean> {
    const count = await this.redis.client.get(this.key(email));
    return count !== null && Number(count) >= LOGIN_MAX_FAILURES;
  }

  /** Counts one wrong password. The pause starts (for a full 15 minutes) at the 5th. */
  async recordFailure(email: string): Promise<number> {
    const key = this.key(email);
    const count = await this.redis.client.incr(key);

    if (count === 1 || count === LOGIN_MAX_FAILURES) {
      await this.redis.client.expire(key, LOGIN_PAUSE_SECONDS);
    }
    return count;
  }

  /** Forgets the failures (after a successful login or password reset). */
  async reset(email: string): Promise<void> {
    await this.redis.client.del(this.key(email));
  }
}