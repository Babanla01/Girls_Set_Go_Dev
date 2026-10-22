/**
 * forgot-password.dto.ts - data accepted when someone asks for a reset link.
 */
import { NormalizedEmail } from '../../common/validation/normalized-email.decorator';

export class ForgotPasswordDto {
  @NormalizedEmail()
  email!: string;
}