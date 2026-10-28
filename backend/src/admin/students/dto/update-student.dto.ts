/**
 * update-student.dto.ts
 * ---------------------------------------------------------------------------
 * What an admin may change about a student: her name and the contact, school
 * and guardian details on her profile. Send only the fields to change.
 *
 * NOT changeable here (anything else is rejected): her email, her date of
 * birth, her role, her account status and her password.
 *
 * To REMOVE the guardian (only allowed for a student who is 18 or older),
 * send all three guardian fields as null.
 *
 * Rules that need several fields together (all-or-none guardian, guardian
 * required under 18) are checked in the service.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';

import { cleanLabel } from '../../../catalog/catalog.util';
import { NormalizedEmail } from '../../../common/validation/normalized-email.decorator';
import { PHONE_MESSAGE, PHONE_PATTERN } from '../../../students/dto/register-student.dto';

/** Trims text and squashes repeated spaces; an empty box counts as "not provided". */
const labelOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? cleanLabel(value) || undefined : value;

/** Trims text; an empty box counts as "not provided". */
const trimmedOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/** Checked only when the field was sent (so "null" is rejected for fields that cannot be empty). */
const whenSent = () => ValidateIf((_object, value) => value !== undefined);

export class UpdateStudentDto {
  @whenSent()
  @Transform(labelOrUndefined)
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @whenSent()
  @Transform(trimmedOrUndefined)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone?: string;

  @whenSent()
  @Transform(labelOrUndefined)
  @IsString()
  @Length(2, 200)
  location?: string;

  @whenSent()
  @Transform(labelOrUndefined)
  @IsString()
  @Length(2, 200)
  schoolName?: string;

  @whenSent()
  @Transform(labelOrUndefined)
  @IsString()
  @Length(1, 50)
  gradeLevel?: string;

  // --- guardian: a value changes it, null removes it ----------------------------

  @IsOptional()
  @Transform(labelOrUndefined)
  @IsString()
  @Length(2, 120)
  guardianName?: string | null;

  @IsOptional()
  @Transform(trimmedOrUndefined)
  @NormalizedEmail()
  guardianEmail?: string | null;

  @IsOptional()
  @Transform(trimmedOrUndefined)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  guardianPhone?: string | null;
}