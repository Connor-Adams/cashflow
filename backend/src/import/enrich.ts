import { logger } from '../observability/logger';
import { mergeSignals } from './enrichment/computeReviewFlag';
import { runNormalizeStage } from './enrichment/normalizeStage';
import { runDetectTypeStage } from './enrichment/detectTypeStage';
import { runDetectRecurringStage, type RecurringHistoryRow } from './enrichment/detectRecurringStage';
import { runApplyRuleStage } from './enrichment/applyRuleStage';
import { runMerchantMemoryStage } from './enrichment/merchantMemoryStage';
import { runLinkItemsStage, type LinkItemsCandidateOrder } from './enrichment/linkItemsStage';
import { runDetectRelationshipsStage, type RelationshipCandidate } from './enrichment/detectRelationshipsStage';
import { runWsInvestmentBrandStage } from './enrichment/wsInvestmentBrandStage';
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
  /**
   * Household member display names (e.g. ['Connor Adams', 'LingLing']). Passed
   * to detect-type so an external payroll direct deposit (income) is told apart
   * from a self-deposit the owner made under their own name (transfer).
   * Optional; when omitted, any external "direct deposit from <X>" is income.
   */
  ownerNames?: string[];
  /** Optional learned-brand lookup for stage 1; orchestrator may pass a memo'd resolver. */
  learnedBrandLookup?: (merchantClean: string) => string | null;
}

function safeStage<T>(name: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    logger.error({ err, stage: name, module: 'enrichment' }, 'enrichment_stage_failed');
    return fallback;
  }
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

function pickMerchantCanonical(signals: Signal[]): string | null {
  for (const s of signals) {
    if (s.fields.merchantCanonical !== undefined) return s.fields.merchantCanonical;
  }
  return null;
}

export async function enrichTransaction(input: EnrichInputs): Promise<EnrichmentResult> {
  const signals: Signal[] = [];

  // Stage 0: ws-investment (Wealthsimple investment-txn rollup)
  // Runs before normalize; PRECEDENCE ranks ws-investment above normalize-seed
  // so when both fire, the WS canonical wins.
  signals.push(...safeStage('ws-investment', () => runWsInvestmentBrandStage({
    merchantRaw: input.raw.merchantRaw,
  }), []));

  // Stage 1: normalize
  signals.push(...safeStage('normalize', () => runNormalizeStage({
    merchantRaw: input.raw.merchantRaw,
    learnedLookup: input.learnedBrandLookup,
  }), []));

  const merchantClean = pickMerchantClean(signals);

  // Stage 2: detect-type
  signals.push(...safeStage('detect-type', () => runDetectTypeStage({
    merchantRaw: input.raw.merchantRaw,
    merchantClean,
    amount: input.raw.amount,
    ownerNames: input.ownerNames,
  }), []));

  const txnType = pickTxnType(signals);

  // Stage 3: detect-recurring
  signals.push(...safeStage('detect-recurring', () => runDetectRecurringStage({
    merchantClean,
    amount: input.raw.amount,
    date: input.raw.date,
    history: input.recurringHistory,
    minSupport: input.recurringMinSupport,
  }), []));

  // Stage 4: apply-rule
  signals.push(...safeStage('apply-rule', () => runApplyRuleStage({
    merchantClean,
    rules: input.rules,
    txnDate: input.raw.date,
  }), []));

  // Stage 5: merchant-memory
  signals.push(...safeStage('merchant-memory', () => runMerchantMemoryStage({
    memory: input.memory,
  }), []));

  // Stage 6: link-items
  signals.push(...safeStage('link-items', () => runLinkItemsStage({
    merchantRaw: input.raw.merchantRaw,
    merchantClean,
    amount: input.raw.amount,
    date: input.raw.date,
    notes: input.raw.notes,
    sourceReference: input.raw.sourceReference,
    threshold: input.amazonLinkThreshold,
    candidateOrders: input.amazonOrders,
  }), []));

  // Stage 7: detect-relationships
  const merchantCanonical = pickMerchantCanonical(signals);
  signals.push(...safeStage('detect-relationships', () => runDetectRelationshipsStage({
    txnType,
    merchantClean,
    merchantCanonical,
    amount: input.raw.amount,
    date: input.raw.date,
    accountId: input.accountId,
    householdAccountIds: input.householdAccountIds,
    refundWindowDays: input.refundWindowDays,
    transferWindowDays: input.transferWindowDays,
    candidates: input.relationshipCandidates,
    sourceReference: input.raw.sourceReference,
  }), []));

  // Stage 9: compute-review-flag (merge)
  return mergeSignals(signals);
}
