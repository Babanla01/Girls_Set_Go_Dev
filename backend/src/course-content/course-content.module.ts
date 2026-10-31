/**
 * course-content.module.ts
 * ---------------------------------------------------------------------------
 * Building a course: its master template, each cohort's own copy, the weeks,
 * lessons and blocks inside them (the draft content), and publishing them as
 * numbered versions.
 *
 * It also REGISTERS the ownership rule "who may open / edit a course copy" with
 * the permission framework (deny by default):
 *   - an admin: any template or cohort copy;
 *   - an instructor: only the copy of a cohort assigned to her;
 *   - everyone else: nothing.
 * The rule is checked against the database on EVERY request, never remembered.
 */
import { Module, OnModuleInit } from '@nestjs/common';
import { ContentKind, Role } from '@prisma/client';

import { AuthModule } from '../auth/auth.module';
import { PolicyService } from '../auth/policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContentEditor, ManageResource } from './content-editor.service';
import { COURSE_CONTENT_MANAGE } from './course-content.constants';
import { CourseContentController } from './course-content.controller';
import { CourseContentService } from './course-content.service';
import { CourseStructureService } from './course-structure.service';
import { CourseVersionsService } from './course-versions.service';
import { LessonBlocksService } from './lesson-blocks.service';

@Module({
  imports: [AuthModule],
  controllers: [CourseContentController],
  providers: [ContentEditor, CourseContentService, CourseStructureService, LessonBlocksService, CourseVersionsService],
  exports: [ContentEditor, CourseVersionsService],
})
export class CourseContentModule implements OnModuleInit {
  constructor(
    private readonly policy: PolicyService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.policy.register<ManageResource>(COURSE_CONTENT_MANAGE, async (user, resource) => {
      if (user.role === Role.ADMIN) return true;
      if (user.role !== Role.INSTRUCTOR) return false;

      // An instructor works only on a cohort's copy, and only for a cohort assigned to her.
      if (resource.kind !== ContentKind.COHORT_COPY || !resource.cohortId) return false;
      const assignments = await this.prisma.cohortInstructor.count({
        where: { cohortId: resource.cohortId, instructorId: user.id },
      });
      return assignments > 0;
    });
  }
}
