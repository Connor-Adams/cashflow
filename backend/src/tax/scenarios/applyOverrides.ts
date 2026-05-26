// backend/src/tax/scenarios/applyOverrides.ts
import { getOverrideKey, validateOverrideMap } from './overrideKeys';
import type { OverrideMap } from './types';
import type { TaxYearFacts } from '../engine/types';

/**
 * Layers a chain of override maps onto a starting facts struct. Maps are applied
 * in order: layer N's overrides are applied to the result of layer N-1.
 *
 * Each override key's behavior (replace vs append) is determined by its registry
 * entry's `apply` function. The function is pure — returns a new facts struct,
 * does not mutate the input.
 *
 * Throws on any unknown key or value that fails its per-key validator.
 */
export function applyOverrides(
  baseFacts: TaxYearFacts,
  overrideChain: OverrideMap[],
): TaxYearFacts {
  let facts = baseFacts;
  for (const map of overrideChain) {
    validateOverrideMap(map);
    for (const [key, value] of Object.entries(map)) {
      const entry = getOverrideKey(key)!; // validated above
      facts = entry.apply(facts, value);
    }
  }
  return facts;
}
