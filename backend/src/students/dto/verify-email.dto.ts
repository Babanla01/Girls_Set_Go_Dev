/**
 * verify-email.dto.ts - the secret from the emailed "confirm your email" link.
 */
import { IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @IsString()
  @Length(20, 200)
  token!: string;
}