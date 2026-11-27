/**
 * grading.module.ts
 * ---------------------------------------------------------------------------
 * Reviewing student work: the inbox, one submission's detail, and saving reviews.
 *
 * It relies on the ownership rule registered by CourseContentModule ("course-content.manage")
 * to decide whose submissions an instructor may review, on the learning module for the shared
 * progress rules and for opening submitted files, and on the achievements module to record a
 * review in the student's activity and to award the badges a review can unlock.
 *
 * It shares GradingScopeService ("whose students may this person see?") and InboxService (the
 * waiting-for-review list) with the instructor workspace, so the dashboard's review queue and
 * the grading inbox can never disagree.
 */
import { Module } from '@nestjs/common';

import { AchievementsModule } from '../achievements/achievements.module';
import { AuthModule } from '../auth/auth.module';
import { LearningModule } from '../learning/learning.module';
import { GradingController } from './grading.controller';
import { GradingScopeService } from './grading-scope.service';
import { InboxService } from './inbox.service';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [AuthModule, LearningModule, AchievementsModule],
  controllers: [GradingController],
  providers: [GradingScopeService, InboxService, ReviewsService],
  exports: [GradingScopeService, InboxService],
})
export class GradingModule {}
