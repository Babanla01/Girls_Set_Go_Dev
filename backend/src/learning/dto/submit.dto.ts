/**
 * submit.dto.ts - the text fields of a submission. The files travel in the same
 * "multipart" form (field name "files"), up to 5 of them.
 */
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { MAX_NOTE_LENGTH } from '../submission.constants';

/** Trims the text; an empty box counts as "not provided". */
const textOrUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class SubmitDto {
  /** A web link (for example Figma or a video). */
  @IsOptional()
  @Transform(textOrUndefined)
  @IsString()
  @MaxLength(2_000)
  linkUrl?: string;

  /** A written note to the instructor. */
  @IsOptional()
  @Transform(textOrUndefined)
  @IsString()
  @MaxLength(MAX_NOTE_LENGTH)
  note?: string;
}
