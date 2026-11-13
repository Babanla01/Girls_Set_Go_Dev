/**
 * grading.controller.ts
 * ---------------------------------------------------------------------------
 * Reviewing student work. Admins and instructors use the SAME addresses; WHICH submissions a
 * person may see is decided on every request (an instructor only gets her own cohorts').
 *
 *   GET /api/v1/grading/inbox                              the submissions waiting for review (filters, search, pages)
 *   GET /api/v1/grading/submissions/:submissionId          one submission: versions, files, rubric, reviews
 *   PUT /api/v1/grading/submissions/:submissionId/review   save (or, within 24 hours, edit) a review
 *                                                           -> answers with the next submission in the queue
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { InboxQuery } from './dto/inbox.query';
import { ReviewDto } from './dto/review.dto';
import { InboxService } from './inbox.service';
import { ReviewsService } from './reviews.service';

@Roles(Role.ADMIN, Role.INSTRUCTOR)
@Controller('grading')
export class GradingController {
  constructor(
    private readonly inbox: InboxService,
    private readonly reviews: ReviewsService,
  ) {}

  @Get('inbox')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: InboxQuery) {
    return this.inbox.list(user, query);
  }

  @Get('submissions/:submissionId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('submissionId', new ParseUUIDPipe()) submissionId: string) {
    return this.reviews.detail(user, submissionId);
  }

  @Put('submissions/:submissionId/review')
  @HttpCode(200)
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Param('submissionId', new ParseUUIDPipe()) submissionId: string,
    @Body() dto: ReviewDto,
    @Req() req: Request,
  ) {
    return this.reviews.save(user, submissionId, dto, getRequestContext(req));
  }
}
