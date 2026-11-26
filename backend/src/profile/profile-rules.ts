/**
 * profile-rules.ts
 * ---------------------------------------------------------------------------
 * Small pure rules for the student profile (no database).
 */
import { MAX_INTEREST_LENGTH, MAX_INTERESTS } from './profile.constants';

/**
 * Tidies the interest chips: trims each one, squeezes inner spaces, drops empty ones and
 * removes repeats (ignoring capital letters - the first spelling wins). The order is kept.
 */
export function cleanInterests(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const text = item.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

/** A plain-English problem with a cleaned list of interests, or null when it is fine. */
export function interestsProblem(items: readonly string[]): string | null {
  if (items.length > MAX_INTERESTS) return `You can add up to ${MAX_INTERESTS} interests.`;
  const tooLong = items.find((item) => item.length > MAX_INTEREST_LENGTH);
  if (tooLong) return `Each interest can be up to ${MAX_INTEREST_LENGTH} characters. "${tooLong.slice(0, 20)}..." is too long.`;
  return null;
}

/** The editable parts of a profile. */
export interface ProfileFields {
  phone: string;
  schoolName: string;
  gradeLevel: string;
  interests: string[];
  goal: string | null;
  afterBootcamp: string | null;
}

/** Which fields differ - used for the audit entry, which records the NAMES of the fields and never their values. */
export function changedFields(before: ProfileFields, after: ProfileFields): (keyof ProfileFields)[] {
  const changed: (keyof ProfileFields)[] = [];
  if (before.phone !== after.phone) changed.push('phone');
  if (before.schoolName !== after.schoolName) changed.push('schoolName');
  if (before.gradeLevel !== after.gradeLevel) changed.push('gradeLevel');
  if (before.interests.length !== after.interests.length || before.interests.some((item, index) => item !== after.interests[index])) {
    changed.push('interests');
  }
  if (before.goal !== after.goal) changed.push('goal');
  if (before.afterBootcamp !== after.afterBootcamp) changed.push('afterBootcamp');
  return changed;
}

/** "Amara Okafor" -> "AO"; a single name -> its first letter. Shown instead of a photo. */
export function initialsOf(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toUpperCase();
}
