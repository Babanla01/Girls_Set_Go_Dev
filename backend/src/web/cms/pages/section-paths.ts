/**
 * section-paths.ts
 * ---------------------------------------------------------------------------
 * A tiny helper to find (and change) values deep inside a section's fields by
 * path, where "[]" means "every item of the list":
 *
 *     "image"            the field "image"
 *     "cards[].body"     the field "body" of every card
 *     "mission.body"     the field "body" inside "mission"
 *
 * Used to turn picture ids into pictures, light-formatting text into safe
 * structures, and to find every picture a page uses.
 */

interface Step {
  key: string;
  each: boolean;
}

const parse = (path: string): Step[] =>
  path.split('.').map((part) => (part.endsWith('[]') ? { key: part.slice(0, -2), each: true } : { key: part, each: false }));

function apply(node: unknown, steps: Step[], change: (value: unknown) => unknown): void {
  if (!node || typeof node !== 'object') return;
  const [step, ...rest] = steps;
  const record = node as Record<string, unknown>;
  const child = record[step.key];

  if (step.each) {
    if (!Array.isArray(child)) return;
    if (rest.length === 0) record[step.key] = child.map(change);
    else for (const item of child) apply(item, rest, change);
  } else if (rest.length === 0) {
    if (step.key in record) record[step.key] = change(child);
  } else {
    apply(child, rest, change);
  }
}

/** A copy of `value` with `change` applied to everything the paths point at. */
export function mapPaths<T>(value: T, paths: readonly string[], change: (value: unknown) => unknown): T {
  const copy = structuredClone(value);
  for (const path of paths) apply(copy, parse(path), change);
  return copy;
}

/** Everything the paths point at, in order. */
export function collectPaths(value: unknown, paths: readonly string[]): unknown[] {
  const found: unknown[] = [];
  mapPaths(value, paths, (item) => {
    found.push(item);
    return item;
  });
  return found;
}