/**
 * public-people.controller.ts
 * ---------------------------------------------------------------------------
 *   GET /api/v1/public/people?kind=TEAM|INSTRUCTOR&placement=about|cohort   (no sign-in)
 * The PUBLISHED team and instructor profiles for the website, in display order.
 * Drafts are never shown. Cheap to call: not rate-limited, cacheable for a minute.
 */
import { Controller, Get, Header, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../../../auth/decorators/public.decorator';
import { PublicPeopleQuery } from './dto/public-people.query';
import { PeopleService } from './people.service';

@Public()
@SkipThrottle()
@Controller('public')
export class PublicPeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get('people')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  list(@Query() query: PublicPeopleQuery) {
    return this.people.listPublic(query);
  }
}