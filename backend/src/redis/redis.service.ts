/**
 * redis.service.ts
 * ---------------------------------------------------------------------------
 * The app's single connection to Redis - a very fast in-memory store.
 * We use it for things that must be quick and shared: rate-limit counters and
 * the "too many wrong passwords" counters. (Later: background jobs.)
 *
 * If Redis is unreachable, requests fail quickly with an error instead of
 * hanging, and the readiness check reports the problem.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { Env } from '../config/env.validation';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  /** The raw Redis client, for modules that need direct access. */
  readonly client: Redis;

  constructor(config: ConfigService<Env, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      // Give up on a command quickly rather than hanging the web request.
      maxRetriesPerRequest: 2,
    });

    // Without a listener, connection errors would crash the process.
    this.client.on('error', (error) => this.logger.warn(`Redis error: ${error.message}`));
  }

  /** Quick "can we reach Redis?" check for the readiness endpoint. */
  async isHealthy(timeoutMs = 2000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis check timed out')), timeoutMs);
    });

    try {
      const reply = await Promise.race([this.client.ping(), timeout]);
      return reply === 'PONG';
    } catch (error) {
      this.logger.warn(`Redis health check failed: ${(error as Error).message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}