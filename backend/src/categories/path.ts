/**
 * Parse a category path string into trimmed segments.
 * `/` is the separator (so category names may not contain it).
 * Throws on any empty segment.
 *
 * This is a pure parser: it says nothing about whether the segments name a
 * coherent chain. In particular a path that repeats a name (`Food / Bar / Food`)
 * parses fine here — under the household-global walk a repeated name carries no
 * information, so `resolveCategoryPath` truncates the path at the repetition
 * rather than rejecting it. Rejecting here would 400 paths the UI's own tree
 * flattener hands the user. See `resolvePath.ts` and
 * docs/superpowers/specs/2026-09-30-cashflow-duplicate-categories-design.md.
 *
 * The thrown message must stay EXACTLY 'invalid category path': both callers
 * compare it with `===` — `util/ensureCategory.ts` swallows it so a bad
 * enrichment mirror name cannot fail the batch, and `routes/categories.ts`
 * POST /resolve-path turns it into a 400. A decorated message would make
 * enrichment throw and the route 500.
 */
export function parseCategoryPath(input: string): string[] {
  const segments = input.split('/').map((s) => s.trim());
  if (segments.some((s) => s.length === 0)) {
    throw new Error('invalid category path');
  }
  return segments;
}
