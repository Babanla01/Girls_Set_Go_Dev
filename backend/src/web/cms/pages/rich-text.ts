/**
 * rich-text.ts
 * ---------------------------------------------------------------------------
 * "Light formatting" for the body text of a section. Editors type simple marks;
 * visitors get a SAFE structure, never raw HTML.
 *
 *   **bold**    *italic*    [link text](https://example.org)
 *   - a bullet            1. a numbered item
 *   (a blank line starts a new paragraph)
 *
 * What is NOT allowed (and refused with a clear message, never silently kept):
 *   - any HTML ("<b>", "<script>", "<img ...>")
 *   - a link that is not a web address (https://), a site path (/about), an
 *     email (mailto:) or a phone number (tel:) - so no "javascript:" links
 *   - invisible control characters
 *
 * The admin screens work with the plain text above. The PUBLIC site API returns
 * the parsed structure below, so the website can draw it without ever inserting
 * HTML into the page.
 */

export interface RichInline {
  text: string;
  bold?: true;
  italic?: true;
  href?: string;
}

export type RichBlock =
  | { type: 'paragraph'; content: RichInline[] }
  | { type: 'list'; ordered: boolean; items: RichInline[][] };

const HTML_START = /<\s*[a-zA-Z/!?]/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const BULLET = /^\s*[-*]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
/** bold, italic (with * or _), or a link. One level only: no marks inside marks. */
const INLINE = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** True for an address that is safe to put in a link or button. */
export function isSafeHref(value: string): boolean {
  const href = value.trim();
  if (href.length === 0 || href.length > 500) return false;

  if (href.startsWith('/')) return !href.startsWith('//') && !/[\s<>"'`\\]/.test(href); // a path on this website
  if (href.startsWith('#')) return /^#[A-Za-z0-9_-]+$/.test(href);
  if (/^mailto:/i.test(href)) return /^mailto:[^\s<>"'`\\]+$/i.test(href);
  if (/^tel:/i.test(href)) return /^tel:\+?[0-9().-]{3,30}$/i.test(href);
  if (/^https?:\/\//i.test(href)) {
    if (/[\s<>"'`\\]/.test(href)) return false;
    try {
      const url = new URL(href);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

/** A plain-English problem with the text, or null when it is fine. */
export function richTextProblem(source: string): string | null {
  if (CONTROL_CHARS.test(source)) return 'This text contains hidden control characters. Please retype it.';
  if (HTML_START.test(source)) return 'HTML is not allowed. Use **bold**, *italic*, [link](https://...) and - bullets.';

  // Every "[text](address)" must have a clean, safe address (no spaces around it).
  for (const match of source.matchAll(/\[([^\]\n]+)\]\(([^)\n]*)\)/g)) {
    if (match[2] !== match[2].trim() || !isSafeHref(match[2])) {
      return `The link "${match[1]}" is not allowed. Use a full web address (https://...), a site path (/about), mailto: or tel:.`;
    }
  }
  return null;
}

/** Turns one line of marks into pieces of text. Assumes the text already passed richTextProblem. */
function parseInline(source: string): RichInline[] {
  const pieces: RichInline[] = [];
  let last = 0;

  for (const match of source.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) pieces.push({ text: source.slice(last, start) });

    if (match[1] !== undefined) pieces.push({ text: match[1], bold: true });
    else if (match[2] !== undefined) pieces.push({ text: match[2], italic: true });
    else if (match[3] !== undefined) pieces.push({ text: match[3], italic: true });
    else if (match[4] !== undefined && match[5] !== undefined) {
      pieces.push(isSafeHref(match[5]) ? { text: match[4], href: match[5] } : { text: match[4] });
    }
    last = start + match[0].length;
  }
  if (last < source.length) pieces.push({ text: source.slice(last) });
  return pieces.filter((piece) => piece.text.length > 0);
}

/** The structure the public website draws. Returns [] for empty text. */
export function parseRichText(source: string): RichBlock[] {
  const text = source.replace(/\r\n?/g, '\n').trim();
  if (text === '') return [];

  const blocks: RichBlock[] = [];
  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    if (lines.every((line) => BULLET.test(line))) {
      blocks.push({ type: 'list', ordered: false, items: lines.map((line) => parseInline(line.replace(BULLET, '').trim())) });
    } else if (lines.every((line) => NUMBERED.test(line))) {
      blocks.push({ type: 'list', ordered: true, items: lines.map((line) => parseInline(line.replace(NUMBERED, '').trim())) });
    } else {
      blocks.push({ type: 'paragraph', content: parseInline(lines.map((line) => line.trim()).join(' ')) });
    }
  }
  return blocks;
}