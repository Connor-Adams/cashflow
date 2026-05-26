// backend/src/tax/scenarios/applyOverrides.ts
import { getOverrideKey, validateOverrideMap } from './overrideKeys';
import type { OverrideMap } from './types';

/**
 * Layers a chain of override maps onto a starting facts struct. Maps are applied
 * in order: layer N's overrides are applied to the result of layer N-1.
 *
 * Each override key's behavior (replace vs append) is determined by its registry
 * entry's `apply` function. The function is pure — returns a new facts struct,
 * does not mutate the input.
 *
 * Generic in `F` so it works for both personal (`TaxYearFacts`) and corp
 * (`CorpTaxYearFacts`) scenarios. The `kind` argument scopes which registry
 * entries are valid; cross-kind usage rejects at the validator.
 *
 * Throws on any unknown key, cross-kind key, or value that fails its per-key validator.
 */
export function applyOverrides<F>(
  baseFacts: F,
  overrideChain: OverrideMap[],
  kind: 'personal' | 'corp',
): F {
  let facts = baseFacts;
  for (const map of overrideChain) {
    validateOverrideMap(map, kind);
    for (const [key, value] of Object.entries(map)) {
      const entry = getOverrideKey(key)!; // validated above
      facts = entry.apply(facts as never, value) as F;
    }
  }
  return facts;
}
