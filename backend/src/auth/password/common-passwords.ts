/**
 * common-passwords.ts
 * ---------------------------------------------------------------------------
 * Base words that appear in nearly every list of "most guessed" passwords.
 * A password is rejected if, after we undo common tricks (P@ssw0rd -> password)
 * and remove digits/symbols, it equals one of these words.
 *
 * This is a short starter list. It is easy to extend: just add more words.
 */
export const COMMON_BASE_WORDS: ReadonlySet<string> = new Set([
  'password', 'passw0rd', 'passcode', 'letmein', 'welcome', 'admin', 'administrator',
  'qwerty', 'qwertyuiop', 'azerty', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm',
  'iloveyou', 'loveyou', 'monkey', 'dragon', 'master', 'shadow', 'sunshine',
  'princess', 'football', 'baseball', 'basketball', 'superman', 'batman',
  'trustno', 'login', 'access', 'hello', 'freedom', 'whatever', 'secret',
  'starwars', 'abc', 'abcdef', 'abcdefgh', 'changeme', 'default', 'guest',
  'test', 'testing', 'tester', 'user', 'root', 'temp', 'temporary', 'summer',
  'winter', 'spring', 'autumn', 'january', 'february', 'march', 'april', 'june',
  'july', 'august', 'september', 'october', 'november', 'december', 'nigeria',
  'lagos', 'abuja', 'naija', 'chelsea', 'arsenal', 'liverpool', 'manutd',
  'girlssetgo', 'girlsetgo', 'school', 'student', 'teacher', 'instructor',
  'lovely', 'blessed', 'jesus', 'godisgood', 'mypassword', 'newpassword',
]);