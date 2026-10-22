/**
 * audit.module.ts - makes the audit log available everywhere (global module).
 */
import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}