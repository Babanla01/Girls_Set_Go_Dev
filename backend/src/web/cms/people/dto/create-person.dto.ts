/**
 * create-person.dto.ts - a new public profile (team member and/or instructor).
 * It always starts as a DRAFT; it can be published once it has a title and a
 * suitable photo.
 */
import { CmsPersonKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

import { cleanLabel } from '../../../../catalog/catalog.util';

const label = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanLabel(value) : value);
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreatePersonDto {
  @Transform(label)
  @IsString()
  @Length(2, 120)
  fullName!: string;

  @IsOptional()
  @Transform(label)
  @IsString()
  @MaxLength(120)
  title?: string;

  /** An optional second title, e.g. "Instructor, Robotics". */
  @IsOptional()
  @Transform(label)
  @IsString()
  @MaxLength(120)
  subtitle?: string;

  @IsOptional()
  @IsEnum(CmsPersonKind)
  kind?: CmsPersonKind;

  /** A short bio: 280 characters at most. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(280)
  bio?: string;

  /** The id of a picture from the PEOPLE folder of the media library. */
  @IsOptional()
  @IsUUID()
  photoAssetId?: string;

  @IsOptional()
  @IsBoolean()
  showOnAbout?: boolean;

  @IsOptional()
  @IsBoolean()
  showOnCohort?: boolean;
}