/**
 * accept-application.dto.ts
 * ---------------------------------------------------------------------------
 * Accepting = choosing a COHORT. The track and course come from the cohort, so
 * a mismatched track/cohort pair is impossible. The note is private (admins only).
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class AcceptApplicationDto {
  @IsUUID()
  cohortId!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  note?: string;
}