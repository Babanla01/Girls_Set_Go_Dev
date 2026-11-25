/**
 * achievements.module.ts
 * ---------------------------------------------------------------------------
 * Badges and the activity log. The learning and grading modules import it so that lessons,
 * submissions and reviews are recorded (ActivityService) and badges are awarded (BadgesService).
 * It depends only on the published-course reader, never on the learning module itself, so the
 * modules do not depend on each other in a circle.
 */
import { Module } from '@nestjs/common';

import { PublishedCourseModule } from '../learning/published-course.module';
import { AchievementsController } from './achievements.controller';
import { AchievementsService } from './achievements.service';
import { ActivityService } from './activity.service';
import { BadgesService } from './badges.service';

@Module({
  imports: [PublishedCourseModule],
  controllers: [AchievementsController],
  providers: [ActivityService, BadgesService, AchievementsService],
  exports: [ActivityService, BadgesService],
})
export class AchievementsModule {}
