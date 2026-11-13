/**
 * grading.module.ts
 * ---------------------------------------------------------------------------
 * Reviewing student work: the inbox, one submission's detail, and saving reviews.
 *
 * It relies on the ownership rule registered by CourseContentModule ("course-content.manage")
 * to decide whose submissions an instructor may review, and on the learning module for the
 * shared progress rules and for opening submitted files.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { LearningModule } from '../learning/learning.module';
import { GradingController } from './grading.controller';
import { GradingScopeService } from './grading-scope.service';
import { InboxService } from './inbox.service';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [AuthModule, LearningModule],
  controllers: [GradingController],
  providers: [GradingScopeService, InboxService, ReviewsService],
})
export class GradingModule {}
