/**
 * upload-checks.ts
 * ---------------------------------------------------------------------------
 * Checks a batch of uploaded files BEFORE anything is stored. Pure functions (no disk, no
 * database), so they are easy to test on their own. Every problem is reported together.
 *
 * For each file:
 *   - its name is cleaned (no folders, no control characters, a sensible length);
 *   - its type (from the extension) must be one the assignment allows;
 *   - it must not be empty and must be within the size limit;
 *   - its contents must really look like that type (see file-types.ts);
 *   - the same file cannot be added twice in one submission.
 */
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

import { ALLOWED_FILE_TYPES, FileType } from '../course-content/assignment-data';
import { FILE_TYPES } from './file-types';
import { MAX_FILE_NAME_LENGTH } from './storage.constants';

/** What the upload library hands us for each file. */
export interface IncomingFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export interface CheckedFile {
  /** The cleaned display name. */
  name: string;
  type: FileType;
  contentType: string;
  buffer: Buffer;
  size: number;
  sha256: string;
}

/** Upload libraries often read a UTF-8 file name as Latin-1 ("cafÃ©"); this puts it right. */
function fixEncoding(name: string): string {
  const bytes = Buffer.from(name, 'latin1');
  return isUtf8(bytes) ? bytes.toString('utf8') : name;
}

/** A safe name for display: no folders, no control characters, not too long (the extension is kept). */
export function cleanFileName(name: string): string {
  const base = fixEncoding(name).split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (cleaned === '') return 'file';
  if (cleaned.length <= MAX_FILE_NAME_LENGTH) return cleaned;

  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_FILE_NAME_LENGTH - extension.length) + extension;
}

/** The lower-case extension without the dot ("jpeg" counts as "jpg"); empty when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  const extension = name.slice(dot + 1).toLowerCase();
  return extension === 'jpeg' ? 'jpg' : extension;
}

export function checkUploads(
  files: readonly IncomingFile[],
  allowed: readonly string[],
  limits: { maxFiles: number; maxBytes: number },
): { files: CheckedFile[]; problems: string[] } {
  const problems: string[] = [];
  const accepted: CheckedFile[] = [];

  if (files.length === 0) return { files: [], problems };
  if (allowed.length === 0) return { files: [], problems: ['This assignment does not accept file uploads. Share a link instead.'] };
  if (files.length > limits.maxFiles) problems.push(`You can upload at most ${limits.maxFiles} files.`);

  const known = new Set<string>(ALLOWED_FILE_TYPES);
  const firstWithChecksum = new Map<string, string>();

  for (const file of files) {
    const name = cleanFileName(file.originalname);
    const extension = extensionOf(name);

    if (!known.has(extension) || !allowed.includes(extension)) {
      problems.push(`"${name}" is not an allowed file type. Allowed: ${allowed.join(', ')}.`);
      continue;
    }
    if (file.size === 0 || file.buffer.length === 0) {
      problems.push(`"${name}" is empty.`);
      continue;
    }
    if (file.size > limits.maxBytes) {
      problems.push(`"${name}" is larger than ${Math.round(limits.maxBytes / (1024 * 1024))} MB.`);
      continue;
    }

    const type = extension as FileType;
    const info = FILE_TYPES[type];
    const wrong = info.problemWith(file.buffer);
    if (wrong) {
      problems.push(`"${name}" ${wrong}. Check that you uploaded the right file.`);
      continue;
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const duplicate = firstWithChecksum.get(sha256);
    if (duplicate) {
      problems.push(`"${name}" is the same file as "${duplicate}".`);
      continue;
    }
    firstWithChecksum.set(sha256, name);

    accepted.push({ name, type, contentType: info.contentType, buffer: file.buffer, size: file.size, sha256 });
  }

  return { files: problems.length === 0 ? accepted : [], problems };
}
