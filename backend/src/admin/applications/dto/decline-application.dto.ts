/**
 * decline-application.dto.ts
 * ---------------------------------------------------------------------------
 * Declining needs:
 *   - `reason`       REQUIRED. Why it was declined. INTERNAL: used for reporting
 *                    only and never shown to the student.
 *   - `personalNote` OPTIONAL (up to 500 characters). A message written for the
 *                    student; it is included in the decline email.
 */
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DeclineReason } from '@prisma/client';

/** Trims the note; an empty box counts as "no note". */
export const trimmedNoteOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

export class DeclineApplicationDto {
  @IsEnum(DeclineReason, { message: 'Please choose a reason (it is used for reporting only).' })
  reason!: DeclineReason;

  @IsOptional()
  @Transform(trimmedNoteOrUndefined)
  @IsString()
  @MaxLength(500)
  personalNote?: string;
}