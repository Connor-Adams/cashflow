import { normalizeMerchant } from '../normalizeMerchant';
import { lookupSeedBrand } from './brandDictionary';
import type { Signal } from './types';

export interface NormalizeStageInput {
  merchantRaw: string;
  /** Optional fallback when seed dict misses. Implementations should be cheap; cache externally. */
  learnedLookup?: (merchantClean: string) => string | null;
}

export function runNormalizeStage(input: NormalizeStageInput): Signal[] {
  const merchantClean = normalizeMerchant(input.merchantRaw);

  const seed = lookupSeedBrand(merchantClean);
  if (seed) {
    return [
      {
        source: 'normalize-seed',
        confidence: 'high',
        fields: { merchantClean, merchantCanonical: seed },
      },
    ];
  }

  const learned = input.learnedLookup ? input.learnedLookup(merchantClean) : null;
  if (learned) {
    return [
      {
        source: 'normalize-learned',
        confidence: 'medium',
        fields: { merchantClean, merchantCanonical: learned },
      },
    ];
  }

  return [
    {
      source: 'normalize-seed',
      confidence: 'high',
      fields: { merchantClean, merchantCanonical: null },
    },
  ];
}
