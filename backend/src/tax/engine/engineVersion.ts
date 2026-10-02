import { createHash } from 'node:crypto';
import type { RateTable } from './types';
import { RATE_TABLES } from './brackets';

/**
 * Bump when ENGINE LOGIC changes in a way that alters a computed number.
 *
 * Both return caches key on a hash of the facts, so a logic correction is
 * invisible until the key changes: identical facts, matching hash, stale row
 * served. Rate CONSTANTS are handled automatically (see
 * `computeEngineFingerprint`) — this integer covers what cannot be hashed:
 * `t1.ts`, `t2.ts`, `amt.ts`, the credit ordering, the line map.
 *
 * History:
 *   1 — pre-versioning baseline.
 *   2 — T1 slip boxes corrected (T5 box 11 replaces box 26 as the taxable
 *       non-eligible amount; T3 box 50 replaces box 49 as the taxable eligible
 *       amount) and the FHSA deduction bounded by accumulated participation room.
 *   3 — catch-up: L47600 / netTaxOwing (c5914eae) and the FHSA lifetime cap
 *       (119148c3) changed t1.ts after 2 shipped without a bump.
 *   4 — CPP/EI read from T4 boxes 16/16A/18 with enhanced CPP on L22215; tax
 *       withheld on T4A/T5/T3 slips counted on L43700; donations credited as a
 *       positive amount; self-employment expenses at their deductible percent
 *       with refunds netted and no longer duplicated onto the T2; pension slips
 *       preferred over pension transactions.
 */
export const ENGINE_VERSION = 4;

/**
 * A digest over the engine version and every encoded rate constant.
 *
 * Folding the tables in is what makes the rate half self-maintaining: editing a
 * bracket in `rates-2026.ts` invalidates every cached return with no human
 * action and no migration. That matters because the alternative — remembering to
 * bump a constant — is exactly the step that gets skipped, and a skipped bump
 * shows the user a number the code no longer computes.
 */
export function computeEngineFingerprint(
  version: number,
  tables: Record<number, RateTable>,
): string {
  return createHash('sha256')
    .update(`engine:${version}\n`)
    .update(canonical(tables))
    .digest('hex');
}

let memo: string | null = null;

/** The running engine's fingerprint. Computed once; the inputs are immutable. */
export function engineFingerprint(): string {
  memo ??= computeEngineFingerprint(ENGINE_VERSION, RATE_TABLES);
  return memo;
}

/**
 * The value stored in `facts_hash` on `TaxReturn` and `ScenarioReturn`.
 *
 * Re-hashes the pair rather than storing a readable `fingerprint:digest` prefix
 * because both columns are `STRING(64)` — exactly one sha256 hex and no room for
 * a prefix. The two hash pipelines that produce `factsDigest` differ (one sorts
 * keys, one uses a Decimal replacer); both funnel through here so the version
 * mixing cannot drift between them.
 */
export function returnCacheKey(factsDigest: string, fingerprint = engineFingerprint()): string {
  return createHash('sha256').update(fingerprint).update('\n').update(factsDigest).digest('hex');
}

/**
 * Stable serialisation: keys sorted so a field reordering in a rate table is not
 * mistaken for a rate change, and Decimals rendered via toString() so their
 * internal `s`/`e`/`d` representation never leaks into the digest.
 */
function canonical(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (isDecimal(value)) return JSON.stringify(String(value));
  if (Array.isArray(value)) return '[' + (value as unknown[]).map(canonical).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}

/**
 * Plain boolean, not a type predicate: a predicate narrows the negative branch
 * to `never` here and breaks the array case below.
 */
function isDecimal(v: object): boolean {
  return 'toFixed' in v && typeof (v as { toFixed: unknown }).toFixed === 'function';
}
