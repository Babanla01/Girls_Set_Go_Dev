/**
 * auth.module.ts
 * ---------------------------------------------------------------------------
 * Groups everything about "who are you and what may you do" into one module.
 * Other modules use what it exports (for example SessionService for the
 * guards, PolicyService for ownership rules).
 */
import { Module } from '@nestjs/common';

import { AdminBootstrapService } from './admin-bootstrap.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password/password.service';
import { PolicyService } from './policy/policy.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AdminBootstrapService,
    LoginAttemptService,
    PasswordService,
    PolicyService,
    SessionService,
    TokenService,
  ],
  exports: [AuthService, AdminBootstrapService, PasswordService, PolicyService, SessionService, TokenService],
})
export class AuthModule {}