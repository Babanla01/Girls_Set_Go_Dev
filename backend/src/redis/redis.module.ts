/**
 * redis.module.ts
 * ---------------------------------------------------------------------------
 * Makes the Redis connection available everywhere (a "global" module).
 */
import { Global, Module } from '@nestjs/common';

import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}