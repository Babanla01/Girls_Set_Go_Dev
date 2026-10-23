/**
 * students.controller.ts
 * ---------------------------------------------------------------------------
 * The student's own web addresses.
 *
 *   POST /api/v1/students/register                  PUBLIC  sign up + apply (signs her in)
 *   POST /api/v1/students/verify-email              PUBLIC  confirm the email address
 *   POST /api/v1/students/me/resend-verification    student send a new confirmation link
 *   GET  /api/v1/students/me/dashboard              student where do I stand?
 */
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import type { Request, Response } from 'express';

import { SENSITIVE_ROUTE_LIMIT } from '../auth/auth.constants';
import { AuthenticatedUser, getRequestContext } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { SessionService } from '../auth/session.service';
import { RegisterStudentDto } from './dto/register-student.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { SIGNUP_ROUTE_LIMIT } from './students.constants';
import { StudentsService } from './students.service';

@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  @Throttle({ default: SIGNUP_ROUTE_LIMIT })
  async register(@Body() dto: RegisterStudentDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.students.register(dto, getRequestContext(req));

    // A bot that filled the hidden trap field gets a believable "success" and nothing else.
    if (result.trapped) return { received: true };

    this.sessions.setCookie(res, result.sessionToken);
    return { user: result.user, application: result.application, emailVerified: result.emailVerified };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  @Throttle({ default: SENSITIVE_ROUTE_LIMIT })
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    await this.students.verifyEmail(dto.token, getRequestContext(req));
    return { message: 'Thank you. Your email address is confirmed.' };
  }

  @Roles(Role.STUDENT)
  @Post('me/resend-verification')
  @HttpCode(200)
  @Throttle({ default: SENSITIVE_ROUTE_LIMIT })
  async resendVerification(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    await this.students.resendVerification(user, getRequestContext(req));
    return { message: 'We have sent you a new confirmation link.' };
  }

  @Roles(Role.STUDENT)
  @Get('me/dashboard')
  dashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.students.dashboard(user);
  }
}