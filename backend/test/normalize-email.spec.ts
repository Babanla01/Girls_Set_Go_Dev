/**
 * normalize-email.spec.ts - the one email-cleaning rule behaves as promised.
 */
import { normalizeEmail } from '../src/common/utils/normalize-email';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('leaves an already-clean email unchanged', () => {
    expect(normalizeEmail('ada@example.com')).toBe('ada@example.com');
  });
});