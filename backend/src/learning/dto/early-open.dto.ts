/**
 * early-open.dto.ts - an instructor or admin opening a week early for ONE student.
 */
import { Transform } from 'class-transformer';
import { IsString, IsUUID, Length } from 'class-validator';

import { cleanLabel } from '../../catalog/catalog.util';

export class EarlyOpenDto {
  /** The week to open (its id in the published course). */
  @IsUUID()
  weekId!: string;

  /** Why it is being opened early. It is kept with the opening, so it can be reviewed later. */
  @Transform(({ value }) => (typeof value === 'string' ? cleanLabel(value) : value))
  @IsString()
  @Length(3, 300)
  reason!: string;
}
