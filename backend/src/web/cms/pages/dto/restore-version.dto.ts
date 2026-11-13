/**
 * restore-version.dto.ts
 *   POST /api/v1/admin/pages/:id/versions/:number/restore   { "baseRevision": 12 }
 * Restoring replaces the DRAFT, so the editor must say which revision it is looking at.
 */
import { IsInt, Min } from 'class-validator';

export class RestoreVersionDto {
  @IsInt()
  @Min(0)
  baseRevision!: number;
}