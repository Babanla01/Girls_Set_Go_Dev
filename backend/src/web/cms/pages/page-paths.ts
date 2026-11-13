/**
 * page-paths.ts
 * ---------------------------------------------------------------------------
 * The rules for a page's address on the website ("/", "/about",
 * "/programs/tech-bootcamp"): lowercase words joined by dashes, one or more
 * levels. The database enforces the same shape (cms_pages_path_format_chk).
 *
 * A few starts are reserved because the website or the API already uses them,
 * so an admin can never create a page that hides the login, the shop or the API.
 */
export const PAGE_PATH_PATTERN = /^\/$|^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export const RESERVED_PATH_STARTS = [
  '/api',
  '/admin',
  '/portal',
  '/login',
  '/logout',
  '/auth',
  '/student',
  '/instructor',
  '/files',
  '/shop',
  '/cart',
  '/checkout',
  '/account',
  '/_next',
] as const;

export const HOME_PATH = '/';

/** Tidies what an admin typed: spaces, capitals, a missing first slash, a trailing slash. */
export function normalizePagePath(input: string): string {
  const cleaned = `/${input.trim().toLowerCase().replace(/\s+/g, '-').replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  return cleaned.length > 1 ? cleaned.replace(/\/+$/, '') : cleaned;
}

/** A plain-English problem with the path, or null when it is fine. */
export function pathProblem(path: string): string | null {
  if (path.length > 120) return 'The address is too long (120 characters at most).';
  if (!PAGE_PATH_PATTERN.test(path)) {
    return 'Use lowercase letters, numbers and dashes, with a slash between levels (for example /programs/tech-bootcamp).';
  }
  if (RESERVED_PATH_STARTS.some((start) => path === start || path.startsWith(`${start}/`))) {
    return 'That address is reserved by the website. Please choose a different one.';
  }
  return null;
}