/**
 * assignment.dto.ts - what the screen may send when saving a week's assignment.
 *
 * Send only the fields to set. When the week has no assignment yet, `title` and
 * `brief` are required and everything else gets a default. The fields are checked in
 * detail by assignment-data.ts. `null` clears successEvidence and expectedMinutes.
 */
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class SaveAssignmentDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  brief?: string;

  /** The numbered "What to include" list (up to 10 short items). */
  @IsOptional()
  @IsArray()
  includes?: string[];

  @IsOptional()
  @IsString()
  successEvidence?: string | null;

  @IsOptional()
  @IsInt()
  expectedMinutes?: number | null;

  /** From: pdf, png, jpg, docx, pptx, zip, ino, py. (A link and a written note are always accepted.) */
  @IsOptional()
  @IsArray()
  allowedFileTypes?: string[];

  /** { criteria: [ { key, levels: [four descriptions] } ] } for all four criteria. */
  @IsOptional()
  @IsObject()
  rubric?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  rubricVisible?: boolean;

  /** The revision the screen was showing (when editing). If someone saved since, the edit is refused. */
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
