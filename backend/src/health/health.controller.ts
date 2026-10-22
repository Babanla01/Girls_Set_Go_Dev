/**
 * health.controller.ts
 * ---------------------------------------------------------------------------
 * Two small endpoints for monitoring tools, Docker and uptime checkers:
 *
 *   GET /api/health        "liveness"  - is the app process running?
 *   GET /api/health/ready  "readiness" - can it actually serve users?
 *                                        (checks database AND Redis; 503 if either is down)
 *
 * Both are public (monitoring tools cannot sign in) and exempt from rate
 * limiting so monitoring is never blocked.
 */
import { Controller, Get, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @SkipThrottle()
  check() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @SkipThrottle()
  async ready() {
    const [databaseUp, redisUp] = await Promise.all([this.prisma.isHealthy(), this.redis.isHealthy()]);

    if (!databaseUp || !redisUp) {
      throw new ServiceUnavailableException(
        `Not ready: database ${databaseUp ? 'up' : 'DOWN'}, redis ${redisUp ? 'up' : 'DOWN'}`,
      );
    }

    return {
      status: 'ok',
      database: 'up',
      redis: 'up',
      timestamp: new Date().toISOString(),
    };
  }
}