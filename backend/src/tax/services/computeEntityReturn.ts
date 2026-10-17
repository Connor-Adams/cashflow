import { TaxReturn } from '../../models';
import { factsHash } from '../util/factsHash';
import { returnCacheKey } from '../engine/engineVersion';
import type { EngineReturn } from '../scenarios/computeScenarioReturn';

interface EntityReturnBase {
  computedAt: Date;
  lines: unknown;
  totals: unknown;
  /**
   * The engine's own warnings array, by reference. The personal route appends to
   * it after this call returns (a failed carryforward roll), which is why the
   * response can carry a warning the persisted row does not — preserved from the
   * original handler deliberately.
   */
  warnings: string[];
}

/**
 * A union rather than an optional field: `engineReturn` exists only on a miss,
 * and the caller that needs it (`rollPersonalCarryforwards` wants Decimals, not
 * the serialised response) must not be able to reach for it after a cache hit.
 *
 * Generic in the engine's return type so that caller keeps the precise shape —
 * widening it to `EngineReturn` erases the Decimal-valued totals the roll reads.
 */
export type EntityReturnResult<R> =
  | (EntityReturnBase & { cached: true })
  | (EntityReturnBase & { cached: false; engineReturn: R });

export interface ComputeEntityReturnArgs<F, R extends EngineReturn> {
  entityId: number;
  /**
   * The year the cache row is keyed by. Not always the year the facts describe:
   * the corp path builds facts from a fiscal-year range and keys the row on that
   * range's start year.
   */
  cacheYear: number;
  facts: F;
  run: (facts: F) => R;
}

/**
 * Compute-and-cache core for a filed-return snapshot, shared by the personal
 * (T1) and corp (T2) return routes.
 *
 * Both handlers previously carried this block verbatim. Consolidating it is what
 * makes the cache key testable without a seeded household over supertest — and
 * the key is the whole point: it carries the engine version, so a correction to
 * a rate constant or to engine logic actually reaches the screen instead of
 * losing to a row computed by the old code from the same facts.
 */
export async function computeEntityReturn<F, R extends EngineReturn>({
  entityId,
  cacheYear,
  facts,
  run,
}: ComputeEntityReturnArgs<F, R>): Promise<EntityReturnResult<R>> {
  const hash = returnCacheKey(factsDigest(facts));

  const cached = await TaxReturn.findOne({ where: { entityId, year: cacheYear } });
  if (cached && cached.factsHash === hash) {
    return {
      cached: true,
      computedAt: cached.computedAt,
      lines: cached.lines,
      totals: cached.totals,
      warnings: cached.warnings as string[],
    };
  }

  const ret = run(facts);
  const lines = serializeLines(
    ret.lines as Parameters<typeof serializeLines>[0],
  );
  const totals = serializeTotals(
    ret.totals as Parameters<typeof serializeTotals>[0],
  );
  const computedAt = new Date();

  if (cached) {
    // Updated in place rather than inserted: the route reads by (entity, year),
    // so a second row would make which snapshot wins arbitrary.
    await cached.update({
      factsHash: hash,
      computedAt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lines: lines as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      totals: totals as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      warnings: ret.warnings as any,
    });
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (TaxReturn.create as any)({
      entityId,
      year: cacheYear,
      factsHash: hash,
      computedAt,
      lines,
      totals,
      warnings: ret.warnings,
    });
  }

  return { cached: false, computedAt, lines, totals, warnings: ret.warnings, engineReturn: ret };
}

// ---------------------------------------------------------------------------
// Serialization: Decimal → string before hashing, DB storage, and response.
// ---------------------------------------------------------------------------

/**
 * The facts component of the cache key.
 *
 * Decimals are flattened to fixed-precision strings first so the digest depends
 * on the VALUE, not on decimal.js's internal `s`/`e`/`d` representation — which
 * would otherwise make `D('1.50')` and `D('1.5')` different facts.
 */
export function factsDigest(facts: unknown): string {
  return factsHash(serializeFacts(facts));
}

function serializeFacts(facts: unknown): unknown {
  return JSON.parse(
    JSON.stringify(facts, (_k, v) => {
      if (
        v !== null &&
        typeof v === 'object' &&
        typeof (v as { toFixed?: unknown }).toFixed === 'function' &&
        (v as { constructor?: { name?: string } }).constructor?.name === 'Decimal'
      ) {
        return (v as { toFixed: (n: number) => string }).toFixed(8);
      }
      return v;
    })
  );
}

function serializeLines(lines: Array<{
  code: string;
  label: string;
  amount: { toFixed: (n: number) => string };
  inputs: Array<{ source: string; amount: { toFixed: (n: number) => string } }>;
  formula?: string;
}>): unknown {
  return lines.map((l) => ({
    ...l,
    amount: l.amount.toFixed(2),
    inputs: l.inputs.map((i) => ({ ...i, amount: i.amount.toFixed(2) })),
  }));
}

function serializeTotals(
  totals: Record<string, { toFixed: (n: number) => string }>,
): unknown {
  return Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [k, v.toFixed(2)]),
  );
}
