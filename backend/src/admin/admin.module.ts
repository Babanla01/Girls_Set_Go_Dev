/**
 * admin.module.ts
 * ---------------------------------------------------------------------------
 * Everything an administrator does through the API lives under this module.
 * So far: instructors, the audit log, tracks, courses and cohorts. Later
 * batches add students, applications and announcements here.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuditLogsController } from './audit-logs/audit-logs.controller';
import { AuditLogsService } from './audit-logs/audit-logs.service';
import { CohortsController } from './cohorts/cohorts.controller';
import { CohortsService } from './cohorts/cohorts.service';
import { CoursesController } from './courses/courses.controller';
import { CoursesService } from './courses/courses.service';
import { InstructorsController } from './instructors/instructors.controller';
import { InstructorsService } from './instructors/instructors.service';
import { TracksController } from './tracks/tracks.controller';
import { TracksService } from './tracks/tracks.service';

@Module({
  imports: [AuthModule],
  controllers: [
    InstructorsController,
    AuditLogsController,
    TracksController,
    CoursesController,
    CohortsController,
  ],
  providers: [InstructorsService, AuditLogsService, TracksService, CoursesService, CohortsService],
})
export class AdminModule {}