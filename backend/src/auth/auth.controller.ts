/**
 * auth.controller.ts
 * ---------------------------------------------------------------------------
 * The public face of authentication: the web addresses (endpoints) and what
 * each one accepts. All the real rules live in AuthService - controllers only
 * translate between HTTP and those rules.
 *
 *   POST /api/v1/auth/login            sign in (through one of three doors)
 *   POST /api/v1/auth/logout           sign out
 *   GET  /api/v1/auth/me               who am I?
 *   POST /api/v1/auth/forgot-password  email me a reset link
 *   POST /api/v1/auth/reset-password   choose a new password with the link
 *   POST /api/v1/auth/accept-invite    choose a first password (invited users)
 */
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { RESET_REQUESTED_MESSAGE, SENSITIVE_ROUTE_LIMIT } from './auth.constants';
import { AuthService } from './auth.service';
import { AuthenticatedRequest, AuthenticatedUser, getRequestContext } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { SetPasswordDto } from './dto/set-password.dto';
import { SessionService } from './session.service';

// Strict per-IP limit (5 per minute) for routes attackers like to hammer.
const sensitiveLimit = { default: SENSITIVE_ROUTE_LIMIT };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle(sensitiveLimit)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, sessionToken } = await this.auth.login(dto, getRequestContext(req));
    this.sessions.setCookie(res, sessionToken);
    return { user };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(user, req.sessionId, getRequestContext(req));
    this.sessions.clearCookie(res);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return { user };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  @Throttle(sensitiveLimit)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.requestPasswordReset(dto.email, getRequestContext(req));
    return { message: RESET_REQUESTED_MESSAGE };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  @Throttle(sensitiveLimit)
  async resetPassword(@Body() dto: SetPasswordDto, @Req() req: Request) {
    await this.auth.resetPassword(dto.token, dto.newPassword, getRequestContext(req));
    return { message: 'Your password has been changed. Please sign in.' };
  }

  @Public()
  @Post('accept-invite')
  @HttpCode(200)
  @Throttle(sensitiveLimit)
  async acceptInvite(@Body() dto: SetPasswordDto, @Req() req: Request) {
    await this.auth.acceptInvite(dto.token, dto.newPassword, getRequestContext(req));
    return { message: 'Your account is ready. Please sign in.' };
  }
}