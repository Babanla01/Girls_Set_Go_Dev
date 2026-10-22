/**
 * set-password.dto.ts
 * ---------------------------------------------------------------------------
 * Data accepted when someone uses an emailed link to choose a password.
 * Used for BOTH "reset my forgotten password" and "accept my invitation".
 *
 * The password RULES (letters + numbers + symbols, common passwords blocked)
 * are checked in the service, so the person gets one clear list of problems.
 */
import { IsString, Length, MaxLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../auth.constants';

export class SetPasswordDto {
  /** The secret from the emailed link. */
  @IsString()
  @Length(20, 200)
  token!: string;

  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}