/**
 * section-fields.ts
 * ---------------------------------------------------------------------------
 * The small building blocks every section type is made from. Each one says what
 * an editor may type and how much. Nothing here ever accepts HTML.
 *
 * A field left empty is allowed while a page is a DRAFT (so autosave never
 * fights the editor); what a section REQUIRES is checked when the page is
 * published (see section-types.ts, "required").
 */
import { z } from 'zod';

import { isSafeHref, richTextProblem } from './rich-text';

const HTML_START = /<\s*[a-zA-Z/!?]/;
const ANY_CONTROL = /[\u0000-\u001F\u007F]/;

/** One line of plain text (no HTML, no line breaks). Empty by default. */
export const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Too long (${max} characters at most).`)
    .refine((value) => !HTML_START.test(value), 'HTML is not allowed here.')
    .refine((value) => !ANY_CONTROL.test(value), 'Line breaks are not allowed here.')
    .default('');

/** Body text with light formatting (see rich-text.ts). Empty by default. */
export const rich = (max: number) =>
  z
    .string()
    .max(max, `Too long (${max} characters at most).`)
    .superRefine((value, context) => {
      const problem = richTextProblem(value);
      if (problem) context.addIssue({ code: 'custom', message: problem });
    })
    .default('');

/** A link address, or empty for "no link". */
export const href = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => value === '' || isSafeHref(value),
    'Use a full web address (https://...), a site path (/about), an email (mailto:) or a phone number (tel:).',
  )
  .default('');

/** A picture from the media library (its id), or none. Checked against the library when saving. */
export const imageRef = z.uuid().nullable().default(null);

export const button = z.strictObject({
  label: text(40),
  href,
  /** Open in a new tab (for links to other websites). */
  newTab: z.boolean().default(false),
});

export const buttons = (max = 3) => z.array(button).max(max, `At most ${max} buttons.`).default([]);

export const link = z.strictObject({ label: text(40), href }).default({ label: '', href: '' });

/** "Heading is required." when the text is empty. */
export const need = (value: string, name: string): string[] => (value.trim() === '' ? [`${name} is required.`] : []);