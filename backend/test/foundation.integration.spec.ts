/**
 * foundation.integration.spec.ts
 * ---------------------------------------------------------------------------
 * Starts the real app (real PostgreSQL + Redis) and checks the basics from
 * Batch 1: health checks, security headers, request ids, error format.
 *
 * Run with:  npm run test:db   (needs Docker's Postgres and Redis running)
 */
import './helpers/integration-env'; // must stay first: sets the environment

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

describe('App foundation (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app); // same global rules as the real server
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GET /api/health reports the app is alive (no sign-in needed)', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/health/ready is OK while database and Redis are up', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up', redis: 'up' });
  });

  it('GET /api/health/ready returns 503 when the database is down', async () => {
    jest.spyOn(app.get(PrismaService), 'isHealthy').mockResolvedValue(false);
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(res.body.message).toContain('database DOWN');
  });

  it('GET /api/health/ready returns 503 when Redis is down', async () => {
    jest.spyOn(app.get(RedisService), 'isHealthy').mockResolvedValue(false);
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(res.body.message).toContain('redis DOWN');
  });

  it('sends protective security headers and hides the framework', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns a request id on every response', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('returns the consistent error shape for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, path: '/api/v1/does-not-exist' });
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });
});