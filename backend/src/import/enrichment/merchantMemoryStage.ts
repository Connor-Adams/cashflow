import type { MerchantMemoryMatch } from '../../ai/merchantMemory';
import type { Signal } from './types';

export interface MerchantMemoryInput {
  memory: MerchantMemoryMatch | null;
}

export function runMerchantMemoryStage(input: MerchantMemoryInput): Signal[] {
  const mem = input.memory;
  if (!mem) return [];

  const confidence: 'high' | 'medium' = mem.supportCount >= 2 ? 'high' : 'medium';

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
        notes: `Auto-categorized from ${mem.supportCount} previous ${mem.merchantClean} transaction${mem.supportCount === 1 ? '' : 's'}.`,
      },
      rationale: `merchant memory has ${mem.supportCount} matching prior decision(s)`,
    },
  ];
}
