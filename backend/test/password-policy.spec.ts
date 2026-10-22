/**
 * password-policy.spec.ts
 * ---------------------------------------------------------------------------
 * The password rules: 10+ characters with a letter, a number and a symbol,
 * and no very common passwords (even disguised).
 */
import { checkPasswordPolicy } from '../src/auth/password/password-policy';

describe('checkPasswordPolicy', () => {
  it('accepts a strong password', () => {
    expect(checkPasswordPolicy('Correct-Horse-9')).toEqual([]);
    expect(checkPasswordPolicy('my sunny garden #42')).toEqual([]); // spaces are fine
  });

  it('rejects a password that is too short', () => {
    expect(checkPasswordPolicy('Ab1!xyz')).toContainEqual(expect.stringContaining('at least 10'));
  });

  it('rejects a password with no number', () => {
    expect(checkPasswordPolicy('Correct-Horse-Battery')).toContainEqual(expect.stringContaining('number'));
  });

  it('rejects a password with no symbol', () => {
    expect(checkPasswordPolicy('CorrectHorse99')).toContainEqual(expect.stringContaining('symbol'));
  });

  it('rejects a password with no letter', () => {
    expect(checkPasswordPolicy('1234567890!!')).toContainEqual(expect.stringContaining('letter'));
  });

  it('rejects common passwords, even with the usual disguises', () => {
    for (const weak of ['Password123!', 'P@ssw0rd123!', 'Qwerty!2345', 'Welcome-2024!', 'Admin@12345']) {
      expect(checkPasswordPolicy(weak)).toContainEqual(expect.stringContaining('too common'));
    }
  });

  it('rejects an absurdly long password', () => {
    expect(checkPasswordPolicy('aA1!'.repeat(40))).toContainEqual(expect.stringContaining('at most'));
  });

  it('reports every problem at once', () => {
    expect(checkPasswordPolicy('abc').length).toBeGreaterThanOrEqual(3);
  });
});