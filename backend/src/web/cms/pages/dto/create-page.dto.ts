/**
 * create-page.dto.ts - a new page: its address on the website and its name.
 *   { "path": "/programs/tech-bootcamp", "title": "Tech Bootcamp" }
 * It starts as an empty draft. The address is tidied (lowercase, leading slash)
 * and checked against the rules in page-paths.ts.
 */
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';

export class CreatePageDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 120)
  path!: string;

  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(2, 150)
  title!: string;
}