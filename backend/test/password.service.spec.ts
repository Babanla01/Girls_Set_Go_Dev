/**
 * password.service.spec.ts
 * ---------------------------------------------------------------------------
 * Hashing and verifying passwords with Argon2id.
 */
import { PasswordService } from '../src/auth/password/password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  beforeAll(async () => {
    await service.onModuleInit();
  });

  it('stores an Argon2id hash, never the password itself', async () => {
    const hash = await service.hash('Correct-Horse-9');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('Correct-Horse-9');
  });

  it('gives a different hash each time (random salt)', async () => {
    expect(await service.hash('Correct-Horse-9')).not.toBe(await service.hash('Correct-Horse-9'));
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await service.hash('Correct-Horse-9');
    expect(await service.verify(hash, 'Correct-Horse-9')).toBe(true);
    expect(await service.verify(hash, 'Correct-Horse-8')).toBe(false);
  });

  it('returns false (not an error) when there is no stored hash', async () => {
    expect(await service.verify(null, 'anything-at-all-1!')).toBe(false);
  });

  it('returns false for a corrupted stored hash', async () => {
    expect(await service.verify('not-a-real-hash', 'Correct-Horse-9')).toBe(false);
  });

  it('does not ask for a rehash when settings are current', async () => {
    expect(service.needsRehash(await service.hash('Correct-Horse-9'))).toBe(false);
  });
});