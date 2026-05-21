import type { Confidence, EnrichmentResult, EnrichmentResultFields, Signal, SignalFields, SignalSource } from './types';

const PRECEDENCE: Array<{ source: SignalSource; minConfidence: Confidence }> = [
  { source: 'rule', minConfidence: 'high' },
  { source: 'recurring', minConfidence: 'high' },
  { source: 'memory', minConfidence: 'high' },
  { source: 'refund-link', minConfidence: 'high' },
  { source: 'transfer-link', minConfidence: 'high' },
  { source: 'amazon-items', minConfidence: 'high' },
  { source: 'ai', minConfidence: 'high' },
  { source: 'memory', minConfidence: 'medium' },
  { source: 'amazon-items', minConfidence: 'medium' },
  { source: 'ai', minConfidence: 'medium' },
  { source: 'normalize-seed', minConfidence: 'high' },
  { source: 'normalize-learned', minConfidence: 'medium' },
  { source: 'type-detect', minConfidence: 'high' },
  { source: 'type-detect', minConfidence: 'medium' },
  { source: 'ai', minConfidence: 'low' },
  { source: 'type-detect', minConfidence: 'low' },
];

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

function signalRank(signal: Signal): number {
  for (let i = 0; i < PRECEDENCE.length; i++) {
    const slot = PRECEDENCE[i];
    if (signal.source === slot.source && CONFIDENCE_RANK[signal.confidence] >= CONFIDENCE_RANK[slot.minConfidence]) {
      return PRECEDENCE.length - i;
    }
  }
  return 0;
}

const AUTO_FIELD_KEYS: Array<keyof SignalFields> = [
  'merchantClean',
  'merchantCanonical',
  'txnType',
  'autoCategory',
  'autoBusiness',
  'autoSplitType',
  'autoPctMe',
  'autoPctPartner',
  'appliedRuleId',
  'linkedTransactionId',
  'linkedExternalOrderId',
  'isRecurring',
  'notes',
];

/**
 * Only classification fields count toward autoSource. Structural fields
 * (merchantClean, merchantCanonical, txnType, isRecurring) are provided by
 * normalize/type-detect stages and should not pollute autoSource with 'composite'
 * when a single classification source (e.g. rule or memory) applies.
 */
const CLASSIFICATION_FIELD_KEYS = new Set<keyof SignalFields>([
  'autoCategory',
  'autoBusiness',
  'autoSplitType',
  'autoPctMe',
  'autoPctPartner',
  'appliedRuleId',
  'linkedTransactionId',
  'linkedExternalOrderId',
  'notes',
]);

export function mergeSignals(signals: Signal[]): EnrichmentResult {
  const sorted = [...signals].sort((a, b) => signalRank(b) - signalRank(a));

  const merged: Partial<EnrichmentResultFields> = {};
  const winningSourceByKey = new Map<string, SignalSource>();

  for (const sig of sorted) {
    for (const key of AUTO_FIELD_KEYS) {
      if (!(key in sig.fields)) continue;
      const value = sig.fields[key];
      if (value === undefined) continue;
      if (merged[key as keyof EnrichmentResultFields] !== undefined) continue;
      (merged as Record<string, unknown>)[key] = value;
      winningSourceByKey.set(key, sig.source);
    }
  }

  const classificationSources = new Set(
    [...winningSourceByKey.entries()]
      .filter(([key]) => CLASSIFICATION_FIELD_KEYS.has(key as keyof SignalFields))
      .map(([, source]) => source),
  );
  const distinctSources = classificationSources;
  const autoSource: EnrichmentResultFields['autoSource'] = (() => {
    if (distinctSources.size === 0) return null;
    if (distinctSources.size === 1) return [...distinctSources][0]!;
    return 'composite';
  })();

  // Confidence of the winning category signal (or any winning non-merchantClean signal)
  const categoryWinner = sorted.find((s) => 'autoCategory' in s.fields && s.fields.autoCategory != null);
  const autoConfidence: Confidence | null = categoryWinner?.confidence ?? null;

  const hasCategory = merged.autoCategory != null;
  const hasNonAiHighConfidence = signals.some(
    (s) => s.confidence === 'high' && s.source !== 'ai' && s.fields.autoCategory != null,
  );
  const reviewFlag = !(hasCategory && hasNonAiHighConfidence);

  const fields: EnrichmentResultFields = {
    merchantClean: merged.merchantClean ?? '',
    merchantCanonical: merged.merchantCanonical ?? null,
    txnType: merged.txnType ?? 'purchase',
    autoCategory: merged.autoCategory ?? null,
    autoBusiness: merged.autoBusiness ?? null,
    autoSplitType: merged.autoSplitType ?? null,
    autoPctMe: merged.autoPctMe ?? null,
    autoPctPartner: merged.autoPctPartner ?? null,
    appliedRuleId: merged.appliedRuleId ?? null,
    linkedTransactionId: merged.linkedTransactionId ?? null,
    linkedExternalOrderId: merged.linkedExternalOrderId ?? null,
    isRecurring: merged.isRecurring ?? false,
    notes: merged.notes ?? null,
    autoSource,
    autoConfidence,
    reviewFlag,
  };

  return { fields, signals };
}
