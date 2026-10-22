/**
 * assign-instructor.dto.ts - which instructor to assign to a cohort.
 */
import { IsUUID } from 'class-validator';

export class AssignInstructorDto {
  @IsUUID()
  instructorId!: string;
}