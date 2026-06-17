/**
 * Stage 8 orchestration — apply the ai-batch stage over the "cold rows" left
 * behind by the deterministic pipeline (rows where reviewFlag stayed true).
 *
 * Extracted from runImport.ts so BOTH the import path and the enrichment
 * backfill path share one implementation (no fork). The OpenAI caller is
 * injectable so callers can keep env/feature-flag checks at their call site
 * and so tests run without network.
 *
 * Runs OUTSIDE any DB transaction: each enhancement is an independent update,
 * so OpenAI latency never holds row locks and partial enhancement is fine
 * (un-enhanced cold rows keep their phase-1 fields and review_flag=true).
 */
import {
  runAiBatchStage,
  type AiBatchCandidate,
  type AiBatchSuggestion,
  type ChatMessage,
} from './aiBatchStage';
import { openaiJson } from '../../ai/openaiJson';
import { getOpenAiConfig } from '../../config/openai';
import { loadCategoryHints } from '../../ai/suggestTransaction';
import {
  computeImportConfidence,
  serializeFlags,
} from '../computeImportConfidence';
import { mergeSignals } from './computeReviewFlag';
import type { Signal } from './types';
import type { MerchantMemoryMatch } from '../../ai/merchantMemory';
import { Transaction, TransactionSignal } from '../../models';
import { logger } from '../../observability/logger';
import {
  enrichmentAiEnabled,
  enrichmentAiMaxMerchants,
  enrichmentAiPerRowConcurrency,
} from '../../config/env';

export type AiBatchSummary = {
  attempted: boolean;
  coldRowCount: number;
  merchantsConsidered: number;
  enhanced: number;
  capped: boolean;
  usedBatch: boolean;
  fellBackToPerRow: boolean;
};

export type ColdRow = {
  txnId: number;
  signals: Signal[];
  merchantKey: string;
  merchantRaw: string;
  merchantClean: string;
  merchantCanonical: string | null;
  amount: number;
  date: string;
  currency: string;
  memory: MerchantMemoryMatch | null;
  /** Captured at insert-time so post-AI confidence reclassification doesn't
   *  need to round-trip through the DB. */
  accountVisibility: 'private' | 'shared';
  txnType: string;
};

export function dedupeColdRowsByMerchantKey(coldRows: ColdRow[]): ColdRow[] {
  const groups = new Map<string, ColdRow>();
  for (const c of coldRows) {
    const existing = groups.get(c.merchantKey);
    if (existing == null || c.date > existing.date) groups.set(c.merchantKey, c);
  }
  return [...groups.values()];
}

function coldRowToCandidate(c: ColdRow): AiBatchCandidate {
  return {
    merchantKey: c.merchantKey,
    sampleMerchantRaw: c.merchantRaw,
    sampleMerchantClean: c.merchantClean,
    sampleMerchantCanonical: c.merchantCanonical,
    sampleAmount: c.amount,
    sampleDate: c.date,
    sampleCurrency: c.currency,
    similarPriors: [],
    memoryMatch: c.memory ? { category: c.memory.category, supportCount: c.memory.supportCount } : null,
  };
}

export function aiSuggestionToSignal(sug: {
  category: string | null;
  business: boolean | null;
  splitType: 'me' | 'partner' | 'shared' | null;
  pctMe: number | null;
  pctPartner: number | null;
  confidence: 'high' | 'medium' | 'low';
  rationale: string | null;
}): Signal {
  return {
    source: 'ai',
    confidence: sug.confidence,
    fields: {
      autoCategory: sug.category,
      autoBusiness: sug.business,
      autoSplitType: sug.splitType,
      autoPctMe: sug.pctMe != null ? String(sug.pctMe) : null,
      autoPctPartner: sug.pctPartner != null ? String(sug.pctPartner) : null,
    },
    ...(sug.rationale ? { rationale: sug.rationale } : {}),
  };
}

async function persistAiEnhancement(c: ColdRow, aiSignal: Signal, householdId: number | null): Promise<boolean> {
  const merged = mergeSignals([...c.signals, aiSignal]);
  // Re-classify import confidence with the merged enrichment fields. An AI
  // suggestion that fills a category and turns reviewFlag off should move
  // the row from 'needs_review' back to 'clean' on the dashboard.
  const confidence = computeImportConfidence({
    reviewFlag: merged.fields.reviewFlag,
    finalCategory: merged.fields.autoCategory,
    autoCategory: merged.fields.autoCategory,
    autoSplitType: merged.fields.autoSplitType,
    finalSplitType:
      merged.fields.autoSplitType === 'partner' ||
      merged.fields.autoSplitType === 'shared'
        ? merged.fields.autoSplitType
        : 'me',
    txnType: c.txnType,
    accountVisibility: c.accountVisibility,
    linkedTransactionId: merged.fields.linkedTransactionId,
    amount: c.amount,
  });
  try {
    // TODO(B2): static update/bulkCreate bypasses the beforeSave category-id hook, so *_category_id stays null on this path. Plan B2's rollup must resolve/backfill these null FKs (or switch to instance saves / individualHooks:true).
    await Transaction.update(
      {
        autoCategory: merged.fields.autoCategory,
        autoBusiness: merged.fields.autoBusiness,
        autoSplitType: merged.fields.autoSplitType,
        autoPctMe: merged.fields.autoPctMe,
        autoPctPartner: merged.fields.autoPctPartner,
        autoSource: merged.fields.autoSource,
        autoConfidence: merged.fields.autoConfidence,
        reviewFlag: merged.fields.reviewFlag,
        importConfidence: confidence.state,
        importConfidenceFlags: serializeFlags(confidence.flags),
      },
      { where: { id: c.txnId } },
    );
    await TransactionSignal.create({
      transactionId: c.txnId,
      source: 'ai',
      confidence: aiSignal.confidence,
      fields: aiSignal.fields,
      rationale: aiSignal.rationale ?? null,
    });
    if (householdId != null) {
      const { ensureCategory } = await import('../../util/ensureCategory');
      await ensureCategory(householdId, merged.fields.autoCategory);
    }
    return true;
  } catch (err) {
    logger.warn({ err, txnId: c.txnId, module: 'enrichment' }, 'enrichment_ai_batch_post_update_failed');
    return false;
  }
}

function emptyAiSummary(coldRowCount: number): AiBatchSummary {
  return {
    attempted: false,
    coldRowCount,
    merchantsConsidered: 0,
    enhanced: 0,
    capped: false,
    usedBatch: false,
    fellBackToPerRow: false,
  };
}

function aiBatchPossible(coldRows: ColdRow[]): boolean {
  if (!enrichmentAiEnabled) return false;
  if (coldRows.length === 0) return false;
  return getOpenAiConfig() != null;
}

async function tryEnhanceColdRow(c: ColdRow, sug: AiBatchSuggestion | undefined, householdId: number | null): Promise<boolean> {
  if (sug == null || sug.category == null) return false;
  return persistAiEnhancement(c, aiSuggestionToSignal(sug), householdId);
}

async function applyAiSuggestionsToColdRows(
  coldRows: ColdRow[],
  suggestions: Map<string, AiBatchSuggestion>,
  householdId: number | null,
): Promise<number> {
  let enhanced = 0;
  for (const c of coldRows) {
    if (await tryEnhanceColdRow(c, suggestions.get(c.merchantKey), householdId)) enhanced += 1;
  }
  return enhanced;
}

export async function maybeRunAiBatchOverColdRows(
  coldRows: ColdRow[],
  householdId: number | null,
  opts?: { openaiCaller?: (msgs: ChatMessage[]) => Promise<Record<string, unknown>> },
): Promise<AiBatchSummary> {
  if (!aiBatchPossible(coldRows)) return emptyAiSummary(coldRows.length);

  const openaiCaller = opts?.openaiCaller ?? ((msgs: ChatMessage[]) => openaiJson(msgs));

  const candidates = dedupeColdRowsByMerchantKey(coldRows).map(coldRowToCandidate);
  const categoryHints = await loadCategoryHints(householdId);
  const result = await runAiBatchStage({
    candidates,
    categoryHints,
    maxMerchants: enrichmentAiMaxMerchants,
    perRowConcurrency: enrichmentAiPerRowConcurrency,
    openaiCaller,
  });
  const enhanced = await applyAiSuggestionsToColdRows(coldRows, result.suggestions, householdId);

  return {
    attempted: true,
    coldRowCount: coldRows.length,
    merchantsConsidered: candidates.length,
    enhanced,
    capped: result.capped,
    usedBatch: result.usedBatch,
    fellBackToPerRow: result.fellBackToPerRow,
  };
}
