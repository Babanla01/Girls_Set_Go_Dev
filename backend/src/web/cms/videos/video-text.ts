/**
 * video-text.ts
 * ---------------------------------------------------------------------------
 * Checks for the two text files that go with a video:
 *   - the CAPTIONS file (WebVTT, English): required to publish
 *   - the TRANSCRIPT (plain text): optional
 * Both must be real UTF-8 text, free of hidden control characters and of anything
 * that looks like HTML markup.
 */
import { CAPTIONS_MAX_BYTES, TRANSCRIPT_MAX_BYTES } from './video.constants';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/; // tab and new lines are fine
const DANGEROUS_TAGS = /<\s*(script|iframe|object|embed|style|link|meta)\b/i;
const HTML_START = /<\s*[a-zA-Z/!?]/;

/** Removes a byte-order mark and makes every line end the same way. */
export function normalizeText(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function captionsProblem(text: string): string | null {
  if (Buffer.byteLength(text) > CAPTIONS_MAX_BYTES) return `The captions file is too large (${Math.round(CAPTIONS_MAX_BYTES / 1000)} KB at most).`;
  if (!/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(text)) return 'This does not look like a WebVTT captions file: it must start with the word WEBVTT.';
  if (!text.includes('-->')) return 'The captions file has no timed lines (a line like 00:00:01.000 --> 00:00:04.000).';
  if (CONTROL_CHARS.test(text)) return 'The captions file contains hidden control characters.';
  if (DANGEROUS_TAGS.test(text)) return 'The captions file contains markup that is not allowed.';
  return null;
}

export function transcriptProblem(text: string): string | null {
  if (text.trim() === '') return 'The transcript is empty.';
  if (Buffer.byteLength(text) > TRANSCRIPT_MAX_BYTES) return `The transcript is too large (${Math.round(TRANSCRIPT_MAX_BYTES / 1000)} KB at most).`;
  if (CONTROL_CHARS.test(text)) return 'The transcript contains hidden control characters.';
  if (HTML_START.test(text)) return 'The transcript must be plain text: remove anything that looks like HTML.';
  return null;
}

/** "Ada Okoye" -> "Ada O." and "ada" -> "Ada": learners are only ever shown as first name + last initial. */
export function firstNameAndInitial(input: string): string | null {
  const parts = input.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return null;

  const word = /^[\p{L}][\p{L}'’-]{0,29}$/u;
  const first = parts[0];
  if (!word.test(first)) return null;
  const given = `${first.charAt(0).toUpperCase()}${first.slice(1)}`;

  if (parts.length === 1) return given;
  const last = parts[parts.length - 1].replace(/\.$/, '');
  if (!/^[\p{L}][\p{L}'’-]*$/u.test(last)) return null;
  return `${given} ${last.charAt(0).toUpperCase()}.`;
}