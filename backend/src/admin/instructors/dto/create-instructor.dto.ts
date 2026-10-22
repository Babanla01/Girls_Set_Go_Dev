/**
 * create-instructor.dto.ts
 * ---------------------------------------------------------------------------
 * What an admin sends to create an instructor: a name and an email.
 * There is deliberately NO password (the instructor chooses their own through
 * the emailed link) and NO role field (this route can only ever create an
 * instructor - extra fields are rejected outright).
 */
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

import { NormalizedEmail } from '../../../common/validation/normalized-email.decorator';

export class CreateInstructorDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, 120)
  fullName!: string;

  @NormalizedEmail()
  email!: string;
}