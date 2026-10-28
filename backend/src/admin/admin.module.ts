/**
 * admin.module.ts
 * ---------------------------------------------------------------------------
 * Everything an administrator does through the API lives under this module.
 * So far: instructors, the audit log, tracks, courses, cohorts, student
 * applications and students (list, detail, edit, suspend, withdraw, move).
 * Later batches add announcements here.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ApplicationsController } from './applications/applications.controller';
import { ApplicationsService } from './applications/applications.service';
import { AuditLogsController } from './audit-logs/audit-logs.controller';
import { AuditLogsService } from './audit-logs/audit-logs.service';
import { CohortsController } from './cohorts/cohorts.controller';
import { CohortsService } from './cohorts/cohorts.service';
import { CoursesController } from './courses/courses.controller';
import { CoursesService } from './courses/courses.service';
import { InstructorsController } from './instructors/instructors.controller';
import { InstructorsService } from './instructors/instructors.service';
import { StudentManagementService } from './students/student-management.service';
import { AdminStudentsController } from './students/students.controller';
import { AdminStudentsService } from './students/students.service';
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
    ApplicationsController,
    AdminStudentsController,
  ],
  providers: [
    InstructorsService,
    AuditLogsService,
    TracksService,
    CoursesService,
    CohortsService,
    ApplicationsService,
    AdminStudentsService,
    StudentManagementService,
  ],
})
export class AdminModule {}