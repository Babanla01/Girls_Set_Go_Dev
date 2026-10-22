/**
 * suspend-instructor.dto.ts
 * ---------------------------------------------------------------------------
 * Suspending needs no input, but an admin may leave a short private reason.
 * The reason goes to the audit log for other admins; the instructor never
 * sees it.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SuspendInstructorDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  reason?: string;
}