/**
 * block.dto.ts - what the screen may send when adding or editing a lesson block.
 *
 * `data` is checked in detail by block-data.ts, because its fields depend on the
 * kind of block. When editing, send the WHOLE `data` object (it replaces the old one).
 */
import { BlockType } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';

export class CreateBlockDto {
  @IsEnum(BlockType)
  type!: BlockType;

  @IsObject()
  data!: Record<string, unknown>;

  /** true = a note for instructors only (hidden from students). */
  @IsOptional()
  @IsBoolean()
  instructorOnly?: boolean;

  /** Where to put it in the lesson (1 = first). Leave out to add it at the end. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  position?: number;
}

export class UpdateBlockDto {
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  instructorOnly?: boolean;

  /** REQUIRED: the revision the screen was showing. If someone saved since, the edit is refused. */
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}
