/**
 * app.setup.ts
 * ---------------------------------------------------------------------------
 * Applies the shared "global rules" to the app. Lives in its own file so the
 * real server (main.ts) and the automated tests configure the app IDENTICALLY -
 * a test that passes therefore reflects how production really behaves.
 */
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Express } from 'express';

import type { Env } from './config/env.validation';

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  // In production we sit behind a reverse proxy (Caddy). Trusting exactly one
  // proxy hop lets rate limiting see the REAL visitor IP, not Caddy's.
  if (isProduction) {
    (app.getHttpAdapter().getInstance() as Express).set('trust proxy', 1);
  }

  // Standard protective HTTP headers (blocks clickjacking, MIME sniffing, etc.).
  app.use(helmet());

  // Reads the session cookie into req.cookies (used by the AuthGuard).
  app.use(cookieParser());

  // Every API address starts with /api, and is versioned: /api/v1/...
  // Versioning lets us improve the API later without breaking existing clients.
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Automatic input checking for every request body:
  //  - whitelist: silently drops fields we did not ask for
  //  - forbidNonWhitelisted: rejects the request if unexpected fields arrive
  //  - transform: converts incoming data to the types we declared
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Allow the frontend (on another address in development) to call the API
  // and send cookies. In production this list is normally empty because the
  // website and API share one address.
  const origins = config.get('CORS_ORIGINS', { infer: true });
  if (origins.length > 0) {
    app.enableCors({ origin: origins, credentials: true });
  }

  // Lets the app close database connections cleanly when it is stopped.
  app.enableShutdownHooks();
}