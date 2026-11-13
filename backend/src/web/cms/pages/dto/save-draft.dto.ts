/**
 * save-draft.dto.ts - autosave of a page's working copy.
 *
 *   PUT /api/v1/admin/pages/:id/draft
 *   {
 *     "baseRevision": 12,                      the revision the editor last saw (required)
 *     "title": "Tech Bootcamp",                optional
 *     "seo": { "title": "...", "description": "...", "imageAssetId": null },   optional
 *     "sections": [ { "id": "...", "type": "hero", "hidden": false, "fields": { ... } }, ... ]
 *   }
 * "sections" is the WHOLE list, in the order they appear (that is how adding, removing,
 * hiding and reordering are saved). A section without an id gets one; the answer returns them.
 * What is inside each section is checked against its type (see section-types.ts).
 */
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsObject, IsOptional, IsString, Length, Min } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';

export class SaveDraftDto {
  @IsInt()
  @Min(0)
  baseRevision!: number;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 150)
  title?: string;

  @IsOptional()
  @IsObject()
  seo?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  sections?: unknown[];
}