/**
 * update-instructor.dto.ts
 * ---------------------------------------------------------------------------
 * What an admin may change on an instructor: the name, and the email (the
 * service only allows an email change while the invitation is still pending).
 * Send only the fields you want to change.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';

import { NormalizedEmail } from '../../../common/validation/normalized-email.decorator';

export class UpdateInstructorDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @IsOptional()
  @NormalizedEmail()
  email?: string;
}