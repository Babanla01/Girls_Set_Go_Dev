/**
 * learning.module.ts
 * ---------------------------------------------------------------------------
 * The student's learning experience: the course overview, lessons, completion,
 * video resume, assignments and submissions, and opening a week early for one student.
 *
 * It relies on the ownership rule registered by CourseContentModule
 * ("course-content.manage") for the early-open action, so both modules must be
 * part of the application (they are, in AppModule). File storage comes from StorageModule.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { AssignmentContextService } from './assignment-context.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { EnrollmentUnlockController } from './enrollment-unlock.controller';
import { LearningAccessService } from './learning-access.service';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { PublishedCourseService } from './published-course.service';
import { SubmissionsService } from './submissions.service';
import { WeekUnlockService } from './week-unlock.service';

@Module({
  imports: [AuthModule, StorageModule],
  controllers: [LearningController, AssignmentsController, EnrollmentUnlockController],
  providers: [
    LearningAccessService,
    PublishedCourseService,
    LearningService,
    AssignmentContextService,
    AssignmentsService,
    SubmissionsService,
    WeekUnlockService,
  ],
  exports: [PublishedCourseService],
})
export class LearningModule {}
