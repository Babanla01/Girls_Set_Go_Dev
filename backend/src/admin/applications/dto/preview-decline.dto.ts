/**
 * preview-decline.dto.ts
 * ---------------------------------------------------------------------------
 * "Show me the email before I send it": the same optional personal note as the
 * decline itself. The reason is not needed (it never appears in the email).
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { trimmedNoteOrUndefined } from './decline-application.dto';

export class PreviewDeclineDto {
  @IsOptional()
  @Transform(trimmedNoteOrUndefined)
  @IsString()
  @MaxLength(500)
  personalNote?: string;
}
