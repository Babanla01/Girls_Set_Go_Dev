/**
 * login.dto.ts - the exact shape of data the login route accepts.
 * Anything else (extra fields, wrong types) is rejected automatically.
 */
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

import { NormalizedEmail } from '../../common/validation/normalized-email.decorator';
import { PASSWORD_MAX_LENGTH, PORTALS, Portal } from '../auth.constants';

export class LoginDto {
  @NormalizedEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  /** Which login page the person used: student, instructor or admin. */
  @IsIn(PORTALS)
  portal!: Portal;
}