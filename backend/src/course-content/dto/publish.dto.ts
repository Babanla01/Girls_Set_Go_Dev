/**
 * publish.dto.ts - what the screen sends when the person confirms "Publish".
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Trims the note; an empty box counts as "no note". */
const textOrUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class PublishDto {
  /** A short note about this version. Leave out to get an automatic summary such as "2 lessons edited". */
  @IsOptional()
  @Transform(textOrUndefined)
  @IsString()
  @MaxLength(300)
  summary?: string;

  /**
   * The draft revision the person reviewed in the confirmation. If someone edited the
   * draft since, publishing is refused so nobody publishes changes they never saw.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedDraftRevision?: number;
}
