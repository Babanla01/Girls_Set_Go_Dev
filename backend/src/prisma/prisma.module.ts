/**
 * prisma.module.ts
 * ---------------------------------------------------------------------------
 * Makes the database service available everywhere in the app without every
 * feature module having to import it ("global" module).
 */
import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}