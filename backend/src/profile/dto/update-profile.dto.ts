/**
 * update-profile.dto.ts - what a student may change about herself.
 *
 *   Editable: phone, school, grade, interests (chips), goal (280 characters), after-bootcamp choice.
 *   Send only what changes. A goal or a choice sent as blank (or null) is cleared.
 *
 *   NOT editable here (PRF-02): name, email, date of birth, location, guardian details. Sending
 *   any of them is refused with a friendly sentence that points to support.
 */
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmpty, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

import { PHONE_MESSAGE, PHONE_PATTERN } from '../../students/dto/register-student.dto';
import { AFTER_BOOTCAMP_KEYS, AfterBootcampKey, MAX_GOAL_LENGTH, SUPPORT_ONLY_MESSAGE } from '../profile.constants';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Blank text becomes null, which means "clear it". */
const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? (value.replace(/\r\n?/g, '\n').trim() === '' ? null : value.replace(/\r\n?/g, '\n').trim()) : value;

export class UpdateProfileDto {
  @IsOptional()
  @Transform(trimmed)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 200)
  schoolName?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 50)
  gradeLevel?: string;

  /** A rough guard here; the exact rules (10 chips, 30 characters each, no repeats) are applied after tidying. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  interests?: string[];

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(MAX_GOAL_LENGTH)
  goal?: string | null;

  @IsOptional()
  @Transform(blankToNull)
  @IsIn(AFTER_BOOTCAMP_KEYS as unknown as string[])
  afterBootcamp?: AfterBootcampKey | null;

  // --- changed through support only: any value here is refused ---------------------------
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) fullName?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) email?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) dateOfBirth?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) city?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) state?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) guardianName?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) guardianEmail?: unknown;
  @IsEmpty({ message: SUPPORT_ONLY_MESSAGE }) guardianPhone?: unknown;
}
