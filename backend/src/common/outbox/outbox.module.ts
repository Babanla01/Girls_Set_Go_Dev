/**
 * outbox.module.ts - makes the email outbox available everywhere (global module).
 */
import { Global, Module } from '@nestjs/common';

import { OutboxService } from './outbox.service';

@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}