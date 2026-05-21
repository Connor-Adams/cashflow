import { mergeSignals } from './enrichment/computeReviewFlag';
import { runNormalizeStage } from './enrichment/normalizeStage';
import { runDetectTypeStage } from './enrichment/detectTypeStage';
import { runDetectRecurringStage, type RecurringHistoryRow } from './enrichment/detectRecurringStage';
import { runApplyRuleStage } from './enrichment/applyRuleStage';
import { runMerchantMemoryStage } from './enrichment/merchantMemoryStage';
import { runLinkItemsStage, type LinkItemsCandidateOrder } from './enrichment/linkItemsStage';
import { runDetectRelationshipsStage, type RelationshipCandidate } from './enrichment/detectRelationshipsStage';
import type { EnrichmentResult, Signal, TxnType } from './enrichment/types';
import type { RuleRow } from './applyRules';
import type { MerchantMemoryMatch } from '../ai/merchantMemory';

export interface EnrichRawInputs {
  merchantRaw: string;
  date: string;
  amount: number;
  sourceReference: string | null;
  notes: string | null;
}

export interface EnrichInputs {
  raw: EnrichRawInputs;
  accountId: number;
  householdId: number | null;
  householdAccountIds: number[];
  rules: RuleRow[];
  amazonOrders: LinkItemsCandidateOrder[];
  memory: MerchantMemoryMatch | null;
  recurringHistory: RecurringHistoryRow[];
  relationshipCandidates: RelationshipCandidate[];
  refundWindowDays: number;
  transferWindowDays: number;
  recurringMinSupport: number;
  amazonLinkThreshold: number;
  /** Optional learned-brand lookup for stage 1; orchestrator may pass a memo'd resolver. */
  learnedBrandLookup?: (merchantClean: string) => string | null;
}

function pickTxnType(signals: Signal[]): TxnType {
  for (const s of signals) {
    if (s.fields.txnType) return s.fields.txnType;
  }
  return 'purchase';
}

function pickMerchantClean(signals: Signal[]): string {
  for (const s of signals) {
    if (s.fields.merchantClean != null) return s.fields.merchantClean;
  }
  return '';
}

export async function enrichTransaction(input: EnrichInputs): Promise<EnrichmentResult> {
  const signals: Signal[] = [];

  // Stage 1: normalize
  signals.push(...runNormalizeStage({
    merchantRaw: input.raw.merchantRaw,
    learnedLookup: input.learnedBrandLookup,
  }));

  const merchantClean = pickMerchantClean(signals);

  // Stage 2: detect-type
  signals.push(...runDetectTypeStage({
    merchantRaw: input.raw.merchantRaw,
    merchantClean,
    amount: input.raw.amount,
  }));

  const txnType = pickTxnType(signals);

  // Stage 3: detect-recurring
  signals.push(...runDetectRecurringStage({
    merchantClean,
    amount: input.raw.amount,
    date: input.raw.date,
    history: input.recurringHistory,
    minSupport: input.recurringMinSupport,
  }));

  // Stage 4: apply-rule
  signals.push(...runApplyRuleStage({
    merchantClean,
    rules: input.rules,
  }));

  // Stage 5: merchant-memory
  signals.push(...runMerchantMemoryStage({
    memory: input.memory,
  }));

  // Stage 6: link-items
  signals.push(...runLinkItemsStage({
    merchantRaw: input.raw.merchantRaw,
    merchantClean,
    amount: input.raw.amount,
    date: input.raw.date,
    notes: input.raw.notes,
    sourceReference: input.raw.sourceReference,
    threshold: input.amazonLinkThreshold,
    candidateOrders: input.amazonOrders,
  }));

  // Stage 7: detect-relationships
  signals.push(...runDetectRelationshipsStage({
    txnType,
    merchantClean,
    amount: input.raw.amount,
    date: input.raw.date,
    accountId: input.accountId,
    householdAccountIds: input.householdAccountIds,
    refundWindowDays: input.refundWindowDays,
    transferWindowDays: input.transferWindowDays,
    candidates: input.relationshipCandidates,
  }));

  // Stage 9: compute-review-flag (merge)
  return mergeSignals(signals);
}
