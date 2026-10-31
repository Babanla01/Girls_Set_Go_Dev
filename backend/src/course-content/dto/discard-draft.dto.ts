/**
 * discard-draft.dto.ts - what the screen sends when the person confirms "Discard draft changes".
 */
import { IsInt, IsOptional, Min } from 'class-validator';

export class DiscardDraftDto {
  /**
   * The draft revision the person reviewed. If someone edited the draft since, the discard
   * is refused so nobody throws away work they never saw.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedDraftRevision?: number;
}
