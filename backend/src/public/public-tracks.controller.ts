/**
 * public-tracks.controller.ts
 * ---------------------------------------------------------------------------
 * GET /api/v1/public/tracks  - PUBLIC (no sign-in): the tracks a visitor can
 * choose from on the signup form. Only ACTIVE tracks, only names and
 * descriptions - nothing else about the system is exposed.
 */
import { Controller, Get } from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@Controller('public/tracks')
export class PublicTracksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const tracks = await this.prisma.track.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, description: true },
    });
    return { tracks };
  }
}