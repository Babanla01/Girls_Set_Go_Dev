/**
 * publish-page.dto.ts
 *   POST /api/v1/admin/pages/:id/publish   { "baseRevision": 12, "note": "Updated the dates" }
 * The note is optional and appears in the version history.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class PublishPageDto {
  @IsInt()
  @Min(0)
  baseRevision!: number;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(500)
  note?: string;
}