/**
 * assignments.controller.ts
 * ---------------------------------------------------------------------------
 * The student's assignments (students only).
 *
 *   GET  /api/v1/learn/assignments?tab=all|todo|submitted|feedback    the list
 *   GET  /api/v1/learn/assignments/:assignmentId                      one assignment, with her submission
 *                                                                      (title and reason only if its week is locked)
 *   POST /api/v1/learn/assignments/:assignmentId/submissions          send work (or a new version of it)
 *        as a "multipart" form: up to 5 files in the field "files", plus the text fields
 *        "linkUrl" and "note". Limited to 10 sends a minute.
 *
 * Files are held in memory while they are checked (at most 5 x 20 MB), then stored.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { memoryStorage } from 'multer';

import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { MAX_UPLOAD_BYTES } from './uploads/upload.constants';
import { SubmitDto } from './dto/submit.dto';
import { AssignmentTab, AssignmentsService } from './assignments.service';
import { MAX_SUBMISSION_FILES } from './submission.constants';
import { SubmissionsService } from './submissions.service';

@Roles(Role.STUDENT)
@Controller('learn/assignments')
export class AssignmentsController {
  constructor(
    private readonly assignments: AssignmentsService,
    private readonly submissions: SubmissionsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('tab') tab: string = 'all') {
    return this.assignments.list(user, tab as AssignmentTab);
  }

  @Get(':assignmentId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string) {
    return this.assignments.detail(user, assignmentId);
  }

  @Post(':assignmentId/submissions')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FilesInterceptor('files', MAX_SUBMISSION_FILES, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_SUBMISSION_FILES, fields: 10, fieldSize: 20_000, parts: 20 },
    }),
  )
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() dto: SubmitDto,
    @Req() req: Request,
  ) {
    return this.submissions.submit(user, assignmentId, files ?? [], dto, getRequestContext(req));
  }
}