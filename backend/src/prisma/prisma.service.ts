/**
 * prisma.service.ts
 * ---------------------------------------------------------------------------
 * The app's single connection to the database (via Prisma).
 *
 * Plain-English notes:
 *  - ONE shared instance serves the whole app (Prisma manages a pool of
 *    connections internally, which is both fast and safe).
 *  - It connects when the app starts. If the database is unreachable the app
 *    refuses to start ("fail fast") instead of failing on the first request.
 *  - It disconnects cleanly when the app stops.
 *  - The database address comes from our validated settings, not directly
 *    from process.env.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

import type { Env } from '../config/env.validation';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    super({
      datasourceUrl: config.get('DATABASE_URL', { infer: true }),
      // Only surface problems; routine query logging would be slow and noisy.
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Quick "can we reach the database?" check used by the readiness endpoint.
   * Gives up after `timeoutMs` so a hung database cannot hang the health check.
   */
  async isHealthy(timeoutMs = 2000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Database check timed out')), timeoutMs);
    });

    try {
      await Promise.race([this.$queryRaw`SELECT 1`, timeout]);
      return true;
    } catch (error) {
      this.logger.warn(`Database health check failed: ${(error as Error).message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}