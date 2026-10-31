/**
 * restore.dto.ts - what the screen sends when the person confirms "Restore this version".
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** Trims the note; an empty box counts as "no note". */
const textOrUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class RestoreDto {
  /**
   * Restoring REPLACES the draft. If the draft has unpublished changes, the restore is
   * refused unless the person confirms that those changes may be thrown away.
   */
  @IsOptional()
  @IsBoolean()
  discardDraftChanges?: boolean;

  /** A short note for the new version. Leave out to get "Restored version N". */
  @IsOptional()
  @Transform(textOrUndefined)
  @IsString()
  @MaxLength(300)
  summary?: string;
}
