/**
 * update-person.dto.ts - change a profile. Send only what should change.
 * Send `"subtitle": null` or `"photoAssetId": null` to clear them (a PUBLISHED
 * profile must keep its title and photo: unpublish it first).
 */
import { CmsPersonKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';

const label = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanLabel(value) : value);
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdatePersonDto {
  @IsOptional()
  @Transform(label)
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @IsOptional()
  @Transform(label)
  @IsString()
  @MaxLength(120)
  title?: string;

  /** null removes it. (IsOptional lets null through on purpose.) */
  @IsOptional()
  @Transform(label)
  @IsString()
  @MaxLength(120)
  subtitle?: string | null;

  @IsOptional()
  @IsEnum(CmsPersonKind)
  kind?: CmsPersonKind;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(280)
  bio?: string;

  /** null removes the photo. */
  @IsOptional()
  @IsUUID()
  photoAssetId?: string | null;

  @IsOptional()
  @IsBoolean()
  showOnAbout?: boolean;

  @IsOptional()
  @IsBoolean()
  showOnCohort?: boolean;
}