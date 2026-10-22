/**
 * health.module.ts
 * ---------------------------------------------------------------------------
 * Groups the health check into its own self-contained "module".
 * Every feature in this app (auth, courses, ...) will be its own module.
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}