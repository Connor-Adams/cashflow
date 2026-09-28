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
import { resolveFinalCategory } from '../calculateShares';
import type { Signal } from './types';
import type { MerchantMemoryMatch } from '../../ai/merchantMemory';
import { Transaction, TransactionSignal } from '../../models';
import { logger } from '../../observability/logger';
import {
  enrichmentAiEnabled,
  enrichmentAiMaxMerchants,
  enrichmentAiPerRowConcurrency,
} from '../../config/env';

/**
 * Why the stage emitted nothing. Same rationale as
 * `EmbeddingMatchSkipReason`: `attempted: false` alone could not tell an
 * unavailable fallback apart from an import with nothing left to categorise,
 * which is how a stage that had never once run in production stayed invisible.
 */
export type AiBatchSkipReason =
  /** ENRICHMENT_AI_ENABLED=false. */
  | 'disabled'
  /** Rules, memory and embedding-match resolved everything. */
  | 'no_cold_rows'
  /** No OPENAI_API_KEY, so `getOpenAiConfig()` returned null. */
  | 'no_openai_config';

export type AiBatchSummary = {
  attempted: boolean;
  coldRowCount: number;
  merchantsConsidered: number;
  enhanced: number;
  capped: boolean;
  usedBatch: boolean;
  fellBackToPerRow: boolean;
  /** Set only when the stage did NOT run. Undefined on a real run. */
  skipReason?: AiBatchSkipReason;
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
  /**
   * The row's user-set category override, captured alongside
   * `accountVisibility` so this stage can apply the project's
   * `final_category` precedence without a round-trip. Always null on the
   * import paths (a brand-new row cannot have one); on the backfill path it
   * may hold a category a human chose, which MUST survive this stage.
   */
  categoryOverride: string | null;
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
  // `final_category` is the column every read path aggregates on (spend
  // rollups, the Sankey aggregator, the uncategorised bucket), so a row this
  // stage resolves has to land there or the whole fallback is inert. The
  // user's own `categoryOverride` still wins — see resolveFinalCategory.
  const finalCategory = resolveFinalCategory(c.categoryOverride, merged.fields.autoCategory);
  // Re-classify import confidence with the merged enrichment fields. An AI
  // suggestion that fills a category and turns reviewFlag off should move
  // the row from 'needs_review' back to 'clean' on the dashboard. It is told
  // the value actually persisted below, not a stand-in for it.
  const confidence = computeImportConfidence({
    reviewFlag: merged.fields.reviewFlag,
    finalCategory,
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
    // NOTE: static update/bulkCreate bypasses the beforeSave category-id hook, so *_category_id stays null momentarily (auto_category_id and final_category_id alike). Migration 20260623000001 backfills any null FKs where the category string is set.
    await Transaction.update(
      {
        autoCategory: merged.fields.autoCategory,
        finalCategory,
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

function emptyAiSummary(coldRowCount: number, skipReason: AiBatchSkipReason): AiBatchSummary {
  return {
    attempted: false,
    coldRowCount,
    merchantsConsidered: 0,
    enhanced: 0,
    capped: false,
    usedBatch: false,
    fellBackToPerRow: false,
    skipReason,
  };
}

/** Null when the stage can run; otherwise the specific reason it cannot. */
function aiBatchSkipReason(coldRows: ColdRow[]): AiBatchSkipReason | null {
  if (!enrichmentAiEnabled) return 'disabled';
  if (coldRows.length === 0) return 'no_cold_rows';
  if (getOpenAiConfig() == null) return 'no_openai_config';
  return null;
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
  const skipReason = aiBatchSkipReason(coldRows);
  if (skipReason != null) return emptyAiSummary(coldRows.length, skipReason);

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
