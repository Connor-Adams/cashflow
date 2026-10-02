/**
 * The single write that BOTH cold-row fallback stages perform — the embedding
 * match (stage 5.5) and the OpenAI batch (stage 8).
 *
 * ## Why this is shared
 *
 * `persistAiEnhancement` and `persistEmbeddingMatch` were a 62-line clone pair
 * (fallow's largest clone group, and a 35-line contiguous jscpd block). They
 * genuinely do the same thing — merge the new signal over the row's existing
 * ones, resolve the two category mirrors, reclassify import confidence from the
 * values actually about to be persisted, write the row, and append an audit
 * signal — and differ in exactly two values: the `transaction_signals.source`
 * this stage stamps, and the pino event logged when the write fails. Those are
 * the parameters below; everything else is shared outright.
 *
 * Runs OUTSIDE any DB transaction (the callers' rationale): each enhancement is
 * an independent update, so provider latency never holds row locks and partial
 * enhancement is fine. A failure is CONTAINED — logged and reported as `false`,
 * never thrown — because neither stage may fail an import.
 */
import { mergeSignals } from './computeReviewFlag';
import { resolveFinalCategory } from '../calculateShares';
import { computeImportConfidence, serializeFlags } from '../computeImportConfidence';
import { Transaction, TransactionSignal } from '../../models';
import { logger } from '../../observability/logger';
import type { Signal } from './types';

/**
 * The part of a cold row this write needs. `ColdRow` (aiBatchOverColdRows.ts)
 * satisfies it structurally — declared here rather than imported so the shared
 * module does not depend back on its caller.
 */
export type EnrichableColdRow = {
  txnId: number;
  signals: Signal[];
  amount: number;
  accountVisibility: 'private' | 'shared';
  txnType: string;
  categoryOverride: string | null;
};

export async function persistColdRowEnrichment(args: {
  row: EnrichableColdRow;
  signal: Signal;
  householdId: number | null;
  /** `transaction_signals.source` for the audit row this appends. */
  signalSource: 'ai' | 'embedding';
  /** pino event name for the contained failure path. */
  failureEvent: string;
}): Promise<boolean> {
  const { row, signal, householdId } = args;
  const merged = mergeSignals([...row.signals, signal]);
  // `final_category` is the column every read path aggregates on (spend rollups,
  // the Sankey aggregator, the uncategorised bucket), so a row either stage
  // resolves has to land there or the whole fallback is invisible downstream.
  // The user's own `categoryOverride` still wins — see resolveFinalCategory.
  const finalCategory = resolveFinalCategory(row.categoryOverride, merged.fields.autoCategory);
  try {
    // Resolve BEFORE the write. A static update bypasses the beforeSave
    // category-id hook, so the ids have to be supplied explicitly — and the
    // string mirrors have to be the resolved node's FLAT name, because
    // loadCategoryHints feeds the model path-form hints it echoes back, and every
    // budget and spend rollup joins final_category as an exact string.
    //
    // This is NOT the hook's resolution: the hook's `resolveCategoryIdByName`
    // cannot read a path and prefers a ROOT of that name, while
    // `resolveCategoryMirror` goes through `resolveCategoryPath`
    // (household-global, lowest id wins). They differ only for a household
    // holding a duplicate name whose nested node is older than the root — a
    // state the Task 6 household-wide unique index removes.
    const { resolveCategoryMirror } = await import('../../util/ensureCategory');
    const autoMirror = await resolveCategoryMirror(householdId, merged.fields.autoCategory);
    // With no `categoryOverride` — every import path, and most backfill rows —
    // `resolveFinalCategory` hands back `autoCategory` itself, so resolving again
    // would be two identical SELECTs per row in a job that sweeps thousands.
    // Identical strings resolve identically, so the first answer is reused.
    const finalMirror =
      finalCategory === merged.fields.autoCategory
        ? autoMirror
        : await resolveCategoryMirror(householdId, finalCategory);
    // Re-classify import confidence with the merged enrichment fields. A
    // suggestion that fills a category and turns reviewFlag off should move the
    // row from 'needs_review' back to 'clean' on the dashboard. It is told the
    // values actually persisted below, not stand-ins for them.
    const confidence = computeImportConfidence({
      reviewFlag: merged.fields.reviewFlag,
      finalCategory: finalMirror.name,
      autoCategory: autoMirror.name,
      autoSplitType: merged.fields.autoSplitType,
      finalSplitType:
        merged.fields.autoSplitType === 'partner' || merged.fields.autoSplitType === 'shared'
          ? merged.fields.autoSplitType
          : 'me',
      txnType: row.txnType,
      accountVisibility: row.accountVisibility,
      linkedTransactionId: merged.fields.linkedTransactionId,
      amount: row.amount,
    });
    await Transaction.update(
      {
        autoCategory: autoMirror.name,
        autoCategoryId: autoMirror.id,
        finalCategory: finalMirror.name,
        finalCategoryId: finalMirror.id,
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
      { where: { id: row.txnId } },
    );
    await TransactionSignal.create({
      transactionId: row.txnId,
      source: args.signalSource,
      confidence: signal.confidence,
      fields: signal.fields,
      rationale: signal.rationale ?? null,
    });
    return true;
  } catch (err) {
    logger.warn({ err, txnId: row.txnId, module: 'enrichment' }, args.failureEvent);
    return false;
  }
}
