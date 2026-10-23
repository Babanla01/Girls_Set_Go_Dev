/**
 * public.module.ts - the few routes anyone may call without signing in.
 */
import { Module } from '@nestjs/common';

import { PublicTracksController } from './public-tracks.controller';

@Module({
  controllers: [PublicTracksController],
})
export class PublicModule {}