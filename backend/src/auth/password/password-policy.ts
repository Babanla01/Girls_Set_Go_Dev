/**
 * password-policy.ts
 * ---------------------------------------------------------------------------
 * The password RULES, as one pure function that returns a list of plain-English
 * problems (an empty list means the password is acceptable).
 *
 * Rules:
 *  - at least 10 characters (and a sane maximum)
 *  - at least one letter, one number and one symbol
 *  - not a very common password (even disguised, like "P@ssw0rd123!")
 */
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth.constants';
import { COMMON_BASE_WORDS } from './common-passwords';

/**
 * Boils a password down to the plain words inside it, in two ways, so common
 * passwords cannot hide behind decoration:
 *   1. drop everything that is not a letter       "Password123!"  -> "password"
 *   2. drop the trailing digits/symbols, then undo look-alike swaps
 *                                                  "P@ssw0rd123!"  -> "password"
 */
function reduceToLetters(password: string): string[] {
  const swaps: Record<string, string> = { '@': 'a', '0': 'o', '1': 'l', '3': 'e', '$': 's', '5': 's', '7': 't', '!': 'i' };
  const lower = password.toLowerCase();

  const lettersOnly = lower.replace(/[^a-z]/g, '');
  const decoded = lower
    .replace(/[^a-z]+$/, '') // trailing "123!" decoration
    .replace(/[@013$57!]/g, (character) => swaps[character] ?? character)
    .replace(/[^a-z]/g, '');

  return [lettersOnly, decoded];
}

export function checkPasswordPolicy(password: string): string[] {
  const problems: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`);
  }
  if (!/\p{L}/u.test(password)) {
    problems.push('Password must include at least one letter.');
  }
  if (!/\p{N}/u.test(password)) {
    problems.push('Password must include at least one number.');
  }
  if (!/[^\p{L}\p{N}\s]/u.test(password)) {
    problems.push('Password must include at least one symbol (for example ! ? # $ %).');
  }
  if (reduceToLetters(password).some((word) => COMMON_BASE_WORDS.has(word))) {
    problems.push('That password is too common. Please choose something less predictable.');
  }

  return problems;
}