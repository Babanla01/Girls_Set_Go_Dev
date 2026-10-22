/**
 * origin.guard.spec.ts
 * ---------------------------------------------------------------------------
 * The forged-request (CSRF) protection: changes must come from our website.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { OriginGuard } from '../src/common/security/origin.guard';

const config = {
  get: (key: string) =>
    key === 'APP_URL' ? 'https://learn.example.org' : ['http://localhost:3000'],
} as unknown as ConfigService<never, true>;

function contextFor(method: string, headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  } as unknown as ExecutionContext;
}

describe('OriginGuard', () => {
  const guard = new OriginGuard(config);

  it('allows reading data from anywhere (GET)', () => {
    expect(guard.canActivate(contextFor('GET', { origin: 'https://evil.example' }))).toBe(true);
  });

  it('allows changes that come from our own website', () => {
    expect(guard.canActivate(contextFor('POST', { origin: 'https://learn.example.org' }))).toBe(true);
    expect(guard.canActivate(contextFor('POST', { origin: 'http://localhost:3000' }))).toBe(true);
  });

  it('refuses changes that come from another website', () => {
    expect(() => guard.canActivate(contextFor('POST', { origin: 'https://evil.example' }))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(contextFor('DELETE', { origin: 'null' }))).toThrow(ForbiddenException);
  });

  it('falls back to the Referer when there is no Origin', () => {
    expect(
      guard.canActivate(contextFor('POST', { referer: 'https://learn.example.org/login?x=1' })),
    ).toBe(true);
    expect(() => guard.canActivate(contextFor('POST', { referer: 'https://evil.example/page' }))).toThrow(
      ForbiddenException,
    );
  });

  it('allows non-browser requests that send neither header', () => {
    expect(guard.canActivate(contextFor('POST'))).toBe(true);
  });

  it('does not let a look-alike address through', () => {
    expect(() =>
      guard.canActivate(contextFor('POST', { origin: 'https://learn.example.org.evil.example' })),
    ).toThrow(ForbiddenException);
  });
});