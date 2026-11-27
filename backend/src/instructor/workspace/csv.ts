/**
 * csv.ts
 * ---------------------------------------------------------------------------
 * Builds a CSV file that is SAFE to open in a spreadsheet. Pure functions.
 *
 *  - A text value that starts with "=", "+", "-", "@" (or a tab / carriage return) would be run
 *    as a FORMULA by Excel or Google Sheets - a known attack when names come from users. Such a
 *    value gets a leading apostrophe, which makes the spreadsheet treat it as plain text.
 *    (Real numbers are written as they are, so a negative number stays a number.)
 *  - Values containing commas, quotes or line breaks are quoted, and quotes are doubled.
 *  - Lines end with CRLF, and the file starts with a BOM so Excel reads accents correctly.
 */
export type CsvValue = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);

  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly (readonly CsvValue[])[]): string {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
