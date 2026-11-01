/**
 * learning.controller.ts
 * ---------------------------------------------------------------------------
 * The student's course. Students only (class-level @Roles(STUDENT)); everything
 * is about the signed-in student's own cohort - there is no id of a course or a
 * cohort to guess.
 *
 *   GET /api/v1/learn/course                                the overview: weeks, lessons, progress, "continue learning"
 *   GET /api/v1/learn/lessons/:lessonId                     one lesson with its blocks (403 with the reason if its week is locked)
 *   POST /api/v1/learn/lessons/:lessonId/complete           "Mark complete & continue" (safe to press twice)
 *   PUT /api/v1/learn/lessons/:lessonId/video-position      remember where she paused a video
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { VideoPositionDto } from './dto/video-position.dto';
import { LearningService } from './learning.service';

@Roles(Role.STUDENT)
@Controller('learn')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Get('course')
  course(@CurrentUser() user: AuthenticatedUser) {
    return this.learning.getCourse(user);
  }

  @Get('lessons/:lessonId')
  lesson(@CurrentUser() user: AuthenticatedUser, @Param('lessonId', new ParseUUIDPipe()) lessonId: string) {
    return this.learning.getLesson(user, lessonId);
  }

  @Post('lessons/:lessonId/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthenticatedUser, @Param('lessonId', new ParseUUIDPipe()) lessonId: string) {
    return this.learning.complete(user, lessonId);
  }

  @Put('lessons/:lessonId/video-position')
  saveVideoPosition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
    @Body() dto: VideoPositionDto,
  ) {
    return this.learning.saveVideoPosition(user, lessonId, dto);
  }
}
