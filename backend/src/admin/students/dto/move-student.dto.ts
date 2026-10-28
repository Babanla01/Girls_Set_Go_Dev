/**
 * move-student.dto.ts - moving a student means choosing the cohort she goes to.
 */
import { IsUUID } from 'class-validator';

export class MoveStudentDto {
  @IsUUID()
  cohortId!: string;
}