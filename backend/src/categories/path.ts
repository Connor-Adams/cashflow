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

/**
 * The LEAF segment of a possibly path-form category string.
 *
 * This is the fallback the AI writers use when `ensureCategory` returns null —
 * which it does for a null/empty name, a malformed path, or a null household.
 * Writing the raw string back in that case is exactly the bug: it is what put
 * ~200 path-form values like `"Household / Rent"` into `final_category`, where
 * they match no budget at all, because every budget and spend rollup joins that
 * column as an exact string. Falling back to the last segment keeps the value
 * joinable even when nothing resolved: `"Household / Rent"` becomes `"Rent"`.
 *
 * Unlike {@link parseCategoryPath} this never throws — empty segments are
 * skipped, not rejected, because a fire-and-forget enrichment writer's fallback
 * must not fail the batch. Null when there is no non-empty segment at all.
 */
export function categoryLeafSegment(input: string | null | undefined): string | null {
  if (input == null) return null;
  const segments = input
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}
