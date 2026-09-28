/**
 * Stage 5.5 orchestration — apply the embedding-match stage over the cold rows
 * left behind by the deterministic pipeline + merchant-memory, BEFORE the
 * OpenAI batch (#792).
 *
 * Mirrors `aiBatchOverColdRows.ts`: shared by both the import path and the
 * enrichment backfill path (no fork). The embedder is injectable so tests run
 * with a seeded stub (no model download / no network) and so the production
 * model is loaded once per process.
 *
 * Returns the cold rows that did NOT match above threshold — those still flow
 * to the OpenAI batch unchanged. Matched rows are persisted here (signal +
 * cleared review flag + reclassified import confidence) and removed from the
 * AI-batch candidate set.
 *
 * Runs OUTSIDE any DB transaction (same rationale as the AI batch): each
 * enhancement is an independent update and an embedding failure must never fail
 * an import.
 */
import {
  ensureEmbedding,
  getDefaultEmbedder,
  loadHouseholdMerchants,
  type Embedder,
  type HouseholdMerchant,
} from '../../ai/merchantEmbeddings';
import {
  runEmbeddingMatchStage,
  type PriorEmbedding,
} from './embeddingMatchStage';
import { mergeSignals } from './computeReviewFlag';
import {
  computeImportConfidence,
  serializeFlags,
} from '../computeImportConfidence';
import { Transaction, TransactionSignal } from '../../models';
import { logger } from '../../observability/logger';
import {
  enrichmentEmbeddingEnabled,
  enrichmentEmbeddingThreshold,
} from '../../config/env';
import type { Signal } from './types';
import type { ColdRow } from './aiBatchOverColdRows';

/**
 * Why the stage emitted nothing. `attempted: false` on its own could not tell
 * "the embedder is not installed" apart from "this household has no priors yet"
 * or "there was nothing cold to match" — so an import that categorised nothing
 * because the fallback was unavailable looked exactly like an import with
 * nothing to categorise. The caller turns the unavailable ones into warnings
 * (see coldRowFallbackWarnings.ts).
 */
export type EmbeddingMatchSkipReason =
  /** ENRICHMENT_EMBEDDING_ENABLED=false. */
  | 'disabled'
  /** The deterministic stages resolved everything; nothing reached this stage. */
  | 'no_cold_rows'
  /** No household to scope priors to — the stage cannot run at all. */
  | 'no_household'
  /** `getDefaultEmbedder()` resolved null: no local embedding model available. */
  | 'embedder_unavailable'
  /** The household has no reviewed, categorised merchants to generalise from. */
  | 'no_priors'
  /** The stage threw and was contained. */
  | 'stage_error';

export type EmbeddingMatchSummary = {
  attempted: boolean;
  coldRowCount: number;
  priorMerchants: number;
  matched: number;
  /** Set only when the stage did NOT run. Undefined on a real run. */
  skipReason?: EmbeddingMatchSkipReason;
};

export type EmbeddingMatchResult = {
  /** Cold rows left below threshold — these proceed to the OpenAI batch. */
  remainingColdRows: ColdRow[];
  summary: EmbeddingMatchSummary;
};

function emptyResult(
  coldRows: ColdRow[],
  skipReason: EmbeddingMatchSkipReason,
): EmbeddingMatchResult {
  return {
    remainingColdRows: coldRows,
    summary: {
      attempted: false,
      coldRowCount: coldRows.length,
      priorMerchants: 0,
      matched: 0,
      skipReason,
    },
  };
}

async function persistEmbeddingMatch(
  c: ColdRow,
  signal: Signal,
  householdId: number | null,
): Promise<boolean> {
  const merged = mergeSignals([...c.signals, signal]);
  const confidence = computeImportConfidence({
    reviewFlag: merged.fields.reviewFlag,
    finalCategory: merged.fields.autoCategory,
    autoCategory: merged.fields.autoCategory,
    autoSplitType: merged.fields.autoSplitType,
    finalSplitType:
      merged.fields.autoSplitType === 'partner' || merged.fields.autoSplitType === 'shared'
        ? merged.fields.autoSplitType
        : 'me',
    txnType: c.txnType,
    accountVisibility: c.accountVisibility,
    linkedTransactionId: merged.fields.linkedTransactionId,
    amount: c.amount,
  });
  try {
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
      source: 'embedding',
      confidence: signal.confidence,
      fields: signal.fields,
      rationale: signal.rationale ?? null,
    });
    if (householdId != null) {
      const { ensureCategory } = await import('../../util/ensureCategory');
      await ensureCategory(householdId, merged.fields.autoCategory);
    }
    return true;
  } catch (err) {
    logger.warn({ err, txnId: c.txnId, module: 'enrichment' }, 'enrichment_embedding_persist_failed');
    return false;
  }
}

/** Embed every distinct household prior merchant, via the read-through cache. */
async function loadPriorEmbeddings(
  merchants: HouseholdMerchant[],
  householdId: number,
  embed: Embedder,
): Promise<PriorEmbedding[]> {
  const priors: PriorEmbedding[] = [];
  for (const m of merchants) {
    const vector = await ensureEmbedding({ householdId, merchantClean: m.merchantClean, embed });
    if (vector.length > 0) priors.push({ merchant: m, vector });
  }
  return priors;
}

/**
 * `embedder` supplies a working embedder outright; `embedderLoader` replaces the
 * *resolution* of one, which is the only way to exercise the unavailable case
 * now that the model is a declared dependency present in dev, CI and the image.
 * Before it existed, "no local embedding model" was reproduced by the package
 * genuinely not being installed — so installing it would have deleted coverage of
 * a path that is still a real production case (an image built without egress, a
 * stripped model cache). Production passes neither.
 */
export type EmbeddingMatchOptions = {
  embedder?: Embedder;
  embedderLoader?: () => Promise<Embedder | null>;
  threshold?: number;
};

export async function maybeRunEmbeddingMatchOverColdRows(
  coldRows: ColdRow[],
  householdId: number | null,
  opts?: EmbeddingMatchOptions,
): Promise<EmbeddingMatchResult> {
  // Checked separately (not as one boolean) so the caller learns WHICH of these
  // is why nothing happened.
  if (!enrichmentEmbeddingEnabled) return emptyResult(coldRows, 'disabled');
  if (coldRows.length === 0) return emptyResult(coldRows, 'no_cold_rows');
  if (householdId == null) return emptyResult(coldRows, 'no_household');

  // The whole stage is wrapped: an embedding model load/compute failure logs a
  // warning, emits no signal, and leaves every cold row in place for the
  // OpenAI batch. It must NEVER throw out of here and fail the import.
  try {
    const loadEmbedder = opts?.embedderLoader ?? getDefaultEmbedder;
    const embed = opts?.embedder ?? (await loadEmbedder());
    if (embed == null) return emptyResult(coldRows, 'embedder_unavailable');

    const merchants = await loadHouseholdMerchants(householdId);
    if (merchants.length === 0) return emptyResult(coldRows, 'no_priors');

    const priors = await loadPriorEmbeddings(merchants, householdId, embed);
    const threshold = opts?.threshold ?? enrichmentEmbeddingThreshold;

    const remaining: ColdRow[] = [];
    let matched = 0;
    for (const c of coldRows) {
      const merchantClean = (c.merchantClean ?? '').trim();
      if (merchantClean.length === 0) {
        remaining.push(c);
        continue;
      }
      // A prior with the identical merchant_clean would be an exact match that
      // merchant-memory already caught; it is excluded so the stage only
      // generalizes to *different* strings.
      const candidatePriors = priors.filter((p) => p.merchant.merchantClean !== c.merchantClean);
      const rowVector = await ensureEmbedding({ householdId, merchantClean: c.merchantClean, embed });
      const signals = runEmbeddingMatchStage({ rowVector, priors: candidatePriors, threshold });
      if (signals.length === 0) {
        remaining.push(c);
        continue;
      }
      const ok = await persistEmbeddingMatch(c, signals[0], householdId);
      if (ok) matched += 1;
      else remaining.push(c);
    }

    return {
      remainingColdRows: remaining,
      summary: {
        attempted: true,
        coldRowCount: coldRows.length,
        priorMerchants: priors.length,
        matched,
      },
    };
  } catch (err) {
    logger.warn({ err, module: 'enrichment' }, 'enrichment_embedding_stage_failed');
    return emptyResult(coldRows, 'stage_error');
  }
}
