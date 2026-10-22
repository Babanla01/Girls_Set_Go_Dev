/**
 * instructor.module.ts
 * ---------------------------------------------------------------------------
 * Everything an instructor does through the API. It also REGISTERS the
 * ownership rule "an instructor may view a cohort only if they are assigned to
 * it" with the permission framework from Batch 3 (deny by default).
 */
import { Module, OnModuleInit } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PolicyService } from '../auth/policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { InstructorCohortsController } from './instructor-cohorts.controller';
import { COHORT_VIEW_ACTION, InstructorCohortsService } from './instructor-cohorts.service';

@Module({
  imports: [AuthModule],
  controllers: [InstructorCohortsController],
  providers: [InstructorCohortsService],
})
export class InstructorModule implements OnModuleInit {
  constructor(
    private readonly policy: PolicyService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    // Checked against the database on EVERY request, never remembered, so an
    // admin removing an assignment takes effect on the very next click.
    this.policy.register<string>(COHORT_VIEW_ACTION, async (user, cohortId) => {
      const assignments = await this.prisma.cohortInstructor.count({
        where: { cohortId, instructorId: user.id },
      });
      return assignments > 0;
    });
  }
}