/**
 * class-session.dto.ts - the live class of a week. The date and time are entered as
 * Chicago time (the programme's timezone), exactly as the instructor sees them.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import { IsCalendarDate } from '../../common/validation/calendar-date.decorator';

const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class SaveClassSessionDto {
  /** The day of the class, "YYYY-MM-DD". */
  @IsCalendarDate()
  date!: string;

  /** The start time, "HH:mm" (24-hour, Chicago time). */
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'time must look like 17:00 (24-hour, Chicago time).' })
  time!: string;

  @IsInt()
  @Min(15)
  @Max(480)
  durationMinutes!: number;

  /** Where students join (a web link). Empty clears it. */
  @IsOptional()
  @Transform(textOrNull)
  @IsString()
  @MaxLength(2000)
  joinUrl?: string | null;

  @IsOptional()
  @Transform(textOrNull)
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
