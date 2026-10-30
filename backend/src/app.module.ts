/**
 * app.module.ts
 * ---------------------------------------------------------------------------
 * The root of the application: wires together settings, logging, rate
 * limiting and every feature module.
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/guards/auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { AuditModule } from './common/audit/audit.module';
import { EmailModule } from './common/email/email.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { OutboxModule } from './common/outbox/outbox.module';
import { OriginGuard } from './common/security/origin.guard';
import { Env, validateEnv } from './config/env.validation';
import { CourseContentModule } from './course-content/course-content.module';
import { HealthModule } from './health/health.module';
import { InstructorModule } from './instructor/instructor.module';
import { PrismaModule } from './prisma/prisma.module';
import { PublicModule } from './public/public.module';
import { RedisModule } from './redis/redis.module';
import { RedisService } from './redis/redis.service';
import { RetentionModule } from './retention/retention.module';
import { StudentsModule } from './students/students.module';

@Module({
  imports: [
    // 1) Settings: read + validate environment variables, available everywhere.
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),

    // 2) Logging: fast structured (JSON) logs. Secrets are redacted so
    //    passwords, cookies and tokens can never end up in a log file.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const isDev = config.get('NODE_ENV', { infer: true }) === 'development';
        return {
          // Express 5 route syntax: apply request logging to every path.
          forRoutes: ['{*splat}'],
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            // Give every request an id (reuse the caller's if provided) and
            // send it back so a user report can be matched to a log line.
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const incoming = req.headers['x-request-id'];
              const id = typeof incoming === 'string' && incoming.length <= 100 ? incoming : randomUUID();
              res.setHeader('X-Request-Id', id);
              return id;
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                'req.body.password',
                'req.body.newPassword',
                'req.body.confirmPassword',
                'req.body.token',
              ],
              censor: '[REDACTED]',
            },
            // Pretty, colourful logs while developing; raw JSON in production.
            transport: isDev
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
          },
        };
      },
    }),

    // 3) Redis connection (global). Used by rate limiting and login protection.
    RedisModule,

    // 4) Rate limiting: at most 100 requests per minute per IP by default
    //    (login and password routes have a much stricter limit of their own).
    //    Counters live in Redis, so they survive restarts and are shared if the
    //    app ever runs on more than one server.
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),

    // 5) Database connection + shared helpers (all global)
    PrismaModule,
    AuditModule,
    OutboxModule,
    // Sending queued emails (run by "npm run email:send") and the nightly
    // removal of declined applicants' data (run by "npm run retention:run").
    EmailModule,
    RetentionModule,

    // 6) Feature modules
    AuthModule,
    AdminModule,
    InstructorModule,
    CourseContentModule,
    StudentsModule,
    PublicModule,
    HealthModule,
  ],
  providers: [
    // GUARDS run on EVERY route, in this exact order:
    //  1. rate limit  2. "did this come from our website?"  3. "are you signed in?"  4. "is your role allowed?"
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Use our consistent error format everywhere.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}