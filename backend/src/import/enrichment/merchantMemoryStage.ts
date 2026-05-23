import type { MerchantMemoryMatch } from '../../ai/merchantMemory';
import type { Signal } from './types';

export interface MerchantMemoryInput {
  memory: MerchantMemoryMatch | null;
}

export function runMerchantMemoryStage(input: MerchantMemoryInput): Signal[] {
  const mem = input.memory;
  if (!mem) return [];

  // Bucket-by-amount matches are trustworthy with as few as 2 priors because
  // the amount itself disambiguates the product (e.g. $11.99 Apple is iCloud,
  // not Apps). Any-amount modal needs ≥4 priors to feel high-confidence —
  // otherwise we keep it at medium so the row still lands in review on
  // umbrella merchants.
  let confidence: 'high' | 'medium' = 'medium';
  if (mem.matchedByAmount && mem.supportCount >= 2) {
    confidence = 'high';
  } else if (!mem.matchedByAmount && mem.supportCount >= 4) {
    confidence = 'high';
  }

  const note = mem.matchedByAmount
    ? `Auto-categorized from ${mem.supportCount} previous ${mem.merchantClean} transaction${mem.supportCount === 1 ? '' : 's'} at this amount.`
    : `Auto-categorized from ${mem.supportCount} previous ${mem.merchantClean} transaction${mem.supportCount === 1 ? '' : 's'}.`;

  return [
    {
      source: 'memory',
      confidence,
      fields: {
        autoCategory: mem.category,
        autoBusiness: mem.business,
        autoSplitType: mem.splitType,
        autoPctMe: mem.pctMe,
        autoPctPartner: mem.pctPartner,
        notes: note,
      },
      rationale: mem.matchedByAmount
        ? `merchant memory: ${mem.supportCount} prior decision(s) at similar amount`
        : `merchant memory: ${mem.supportCount} prior decision(s) across all amounts`,
    },
  ];
}
