/**
 * main.ts
 * ---------------------------------------------------------------------------
 * The entry point: creates the app and starts listening for requests.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import type { Env } from './config/env.validation';

async function bootstrap(): Promise<void> {
  // bufferLogs keeps early messages until the structured logger is ready.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  configureApp(app);

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  await app.listen(port);
  app.get(Logger).log(`API running on port ${port} (GET /api/health)`);
}

void bootstrap();