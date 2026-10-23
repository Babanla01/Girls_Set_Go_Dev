/**
 * register-student.dto.ts
 * ---------------------------------------------------------------------------
 * The exact shape of the signup + application form (from the design guide):
 * personal info, school info, preferred track, application questions, guardian
 * info, account password, and consent. Anything else is rejected.
 *
 * Rules that need more than one field (under-18 guardian rules, matching
 * passwords, password strength) are checked in the service, so the student
 * gets clear messages.
 */
import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { cleanLabel } from '../../catalog/catalog.util';
import { IsCalendarDate } from '../../common/validation/calendar-date.decorator';
import { NormalizedEmail } from '../../common/validation/normalized-email.decorator';
import { PASSWORD_MAX_LENGTH } from '../../auth/auth.constants';

/** Trims text; an empty box counts as "not provided". */
const trimmedOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/** Same, and also squashes repeated spaces (for names and places). */
const labelOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? cleanLabel(value) || undefined : value;

const label = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanLabel(value) : value);
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** 7-30 characters: digits, spaces, dashes, brackets, optional leading +. */
const PHONE_PATTERN = /^\+?[0-9][0-9\s\-()]{5,28}$/;
const PHONE_MESSAGE = 'Please enter a valid phone number.';

export class RegisterStudentDto {
  // --- personal --------------------------------------------------------------
  @Transform(label)
  @IsString()
  @Length(2, 120)
  fullName!: string;

  @NormalizedEmail()
  email!: string;

  @Transform(trimmed)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone!: string;

  @IsCalendarDate()
  dateOfBirth!: string;

  @Transform(label)
  @IsString()
  @Length(2, 200)
  location!: string;

  // --- school ----------------------------------------------------------------
  @Transform(label)
  @IsString()
  @Length(2, 200)
  schoolName!: string;

  @Transform(label)
  @IsString()
  @Length(1, 50)
  gradeLevel!: string;

  // --- preference (grants nothing) ---------------------------------------------
  @IsUUID()
  preferredTrackId!: string;

  // --- application questions -----------------------------------------------------
  @Transform(trimmed)
  @IsString()
  @Length(10, 2000)
  whyJoin!: string;

  @Transform(trimmed)
  @IsString()
  @Length(10, 2000)
  hopeToLearn!: string;

  @IsOptional()
  @Transform(trimmedOrUndefined)
  @IsString()
  @MaxLength(2000)
  stemExperience?: string;

  // --- guardian (required in the service when under 18) -------------------------------
  @IsOptional()
  @Transform(labelOrUndefined)
  @IsString()
  @Length(2, 120)
  guardianName?: string;

  @IsOptional()
  @Transform(trimmedOrUndefined)
  @NormalizedEmail()
  guardianEmail?: string;

  @IsOptional()
  @Transform(trimmedOrUndefined)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  guardianPhone?: string;

  // --- account -------------------------------------------------------------------
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  confirmPassword!: string;

  // --- consent -------------------------------------------------------------------
  @Equals(true, { message: 'You must accept the terms to apply.' })
  acceptTerms!: boolean;

  @Equals(true, { message: 'You must accept the privacy notice to apply.' })
  acceptPrivacy!: boolean;

  @IsOptional()
  @IsBoolean()
  guardianConsent?: boolean;

  // --- bot trap ------------------------------------------------------------------
  /** A hidden field real people never see or fill in. Bots usually do. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}