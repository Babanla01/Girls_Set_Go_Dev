/**
 * retention.module.ts
 * ---------------------------------------------------------------------------
 * The "remove declined applicants' personal data after two months" job.
 * It is run by a command (npm run retention:run), normally once a night from
 * a scheduler on the server - see src/cli/run-retention.ts.
 */
import { Module } from '@nestjs/common';

import { RetentionService } from './retention.service';

@Module({
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}