/**
 * learning.module.ts
 * ---------------------------------------------------------------------------
 * The student's learning experience: the course overview, lessons, completion,
 * video resume, assignments and submissions, and opening a week early for one student.
 *
 * It relies on the ownership rule registered by CourseContentModule
 * ("course-content.manage") for the early-open action, so both modules must be
 * part of the application (they are, in AppModule). File storage and signed links come
 * from the shared PlatformModule (src/platform), which is global.
 *
 * It uses AchievementsModule to record activity and award badges.
 * ProgressStateService, SubmissionFilesService and the published-course reader are exported
 * because the grading module uses them too.
 */
import { Module } from '@nestjs/common';

import { AchievementsModule } from '../achievements/achievements.module';
import { AuthModule } from '../auth/auth.module';
import { AssignmentContextService } from './assignment-context.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { EnrollmentUnlockController } from './enrollment-unlock.controller';
import { LearningAccessService } from './learning-access.service';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { ProgressStateService } from './progress-state.service';
import { PublishedCourseModule } from './published-course.module';
import { SubmissionFilesService } from './submission-files.service';
import { SubmissionsService } from './submissions.service';
import { WeekUnlockService } from './week-unlock.service';

@Module({
  imports: [AuthModule, PublishedCourseModule, AchievementsModule],
  controllers: [LearningController, AssignmentsController, EnrollmentUnlockController],
  providers: [
    LearningAccessService,
    ProgressStateService,
    LearningService,
    AssignmentContextService,
    AssignmentsService,
    SubmissionFilesService,
    SubmissionsService,
    WeekUnlockService,
  ],
  exports: [PublishedCourseModule, ProgressStateService, SubmissionFilesService],
})
export class LearningModule {}
