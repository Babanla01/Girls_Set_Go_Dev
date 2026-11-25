/**
 * published-course.module.ts
 * ---------------------------------------------------------------------------
 * Reads the LIVE published version of a course copy (with a small in-memory cache). It is its
 * own tiny module so the learning, grading and achievements modules can all share ONE cache
 * without depending on each other in a circle.
 */
import { Module } from '@nestjs/common';

import { PublishedCourseService } from './published-course.service';

@Module({
  providers: [PublishedCourseService],
  exports: [PublishedCourseService],
})
export class PublishedCourseModule {}
