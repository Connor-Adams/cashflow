import { normalizeCategoryName } from './normalizeName';

/**
 * Parse a category path string into trimmed segments.
 * `/` is the separator (so category names may not contain it).
 * Throws on any empty segment.
 *
 * Also throws when two segments normalize to the same `name_key`. A category
 * name denotes ONE node per household (see `resolvePath.ts` — the walk resolves
 * household-globally), so `Food / Bar / Food` is malformed: the same name cannot
 * be both the root and its own grandchild. Left unrejected, the walk resolved
 * the repeated leaf back to the ancestor it had already visited and returned a
 * `leafId` that was an ANCESTOR of the node the same call had just created —
 * i.e. it wrote a dangling, unreachable empty category. See
 * docs/superpowers/specs/2026-09-30-cashflow-duplicate-categories-design.md.
 */
export function parseCategoryPath(input: string): string[] {
  const segments = input.split('/').map((s) => s.trim());
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new Error('invalid category path');
  }
  const seen = new Set<string>();
  for (const segment of segments) {
    const nameKey = normalizeCategoryName(segment);
    if (seen.has(nameKey)) {
      // The message must stay EXACTLY 'invalid category path': both callers
      // compare it with `===` — `util/ensureCategory.ts` swallows it so a bad
      // enrichment mirror name cannot fail the batch, and
      // `routes/categories.ts` POST /resolve-path turns it into a 400. A
      // decorated message would make enrichment throw and the route 500.
      // The offending segment rides along as a property instead.
      throw Object.assign(new Error('invalid category path'), { repeatedSegment: segment });
    }
    seen.add(nameKey);
  }
  return segments;
}
