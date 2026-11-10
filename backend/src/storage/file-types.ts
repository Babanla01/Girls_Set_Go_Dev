/**
 * file-types.ts
 * ---------------------------------------------------------------------------
 * The file types an upload may have, and how to recognise a REAL one.
 *
 * A file's name can say anything ("virus.exe" renamed to "work.pdf"), so every upload is
 * also checked against what its first bytes must look like:
 *   pdf   starts with "%PDF-"            png   the 8-byte PNG signature     jpg   FF D8 FF
 *   docx / pptx / zip   start like a zip archive ("PK")
 *   ino / py            plain text: valid UTF-8 with no zero bytes
 *
 * `inline` says whether a browser may show the file in the page (pdf and images); everything
 * else is always offered as a download.
 */
import { isUtf8 } from 'node:buffer';

import { FileType } from '../course-content/assignment-data';

export interface FileTypeInfo {
  contentType: string;
  inline: boolean;
  /** null when the contents look right, otherwise a short reason ("is not a real PDF"). */
  problemWith(buffer: Buffer): string | null;
}

const startsWith = (buffer: Buffer, bytes: number[]): boolean =>
  buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

const signature = (label: string, bytes: number[]) => (buffer: Buffer): string | null =>
  startsWith(buffer, bytes) ? null : `is not a real ${label} file`;

const ZIP_START = [0x50, 0x4b, 0x03, 0x04];

const plainText = (label: string) => (buffer: Buffer): string | null =>
  buffer.includes(0) || !isUtf8(buffer) ? `is not a plain-text ${label} file` : null;

export const FILE_TYPES: Record<FileType, FileTypeInfo> = {
  pdf: { contentType: 'application/pdf', inline: true, problemWith: signature('PDF', [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  png: { contentType: 'image/png', inline: true, problemWith: signature('PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { contentType: 'image/jpeg', inline: true, problemWith: signature('JPEG', [0xff, 0xd8, 0xff]) },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    inline: false,
    problemWith: signature('Word', ZIP_START),
  },
  pptx: {
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    inline: false,
    problemWith: signature('PowerPoint', ZIP_START),
  },
  zip: { contentType: 'application/zip', inline: false, problemWith: signature('zip', ZIP_START) },
  ino: { contentType: 'text/plain; charset=utf-8', inline: false, problemWith: plainText('Arduino') },
  py: { contentType: 'text/plain; charset=utf-8', inline: false, problemWith: plainText('Python') },
};

const INLINE_TYPES = new Set(Object.values(FILE_TYPES).filter((info) => info.inline).map((info) => info.contentType));

/** May a browser show a file of this stored type inside the page? */
export const isInlineContentType = (contentType: string): boolean => INLINE_TYPES.has(contentType);
