import type { Transaction as DbTransaction } from 'sequelize';
import { TransactionSignal } from '../../models';
import { upsertSuggestedOrderLink } from '../../amazon/matcher';
import type { Signal } from './types';

/**
 * Persist the signals one enrichment run produced for one transaction.
 *
 * All three write paths — CSV import (`runImport`), statement commit
 * (`commitStatementImport`) and the enrichment backfill
 * (`runEnrichmentBackfill`) — wrote the same map-and-bulkCreate by hand, so it
 * lives here once instead. `orderLink` and `ruleActions` are deliberately not
 * persisted: they are side-effect instructions applied by the caller, not
 * observations (see the `Signal` docs in ./types).
 *
 * A run that produced no signals writes nothing rather than issuing an empty
 * `bulkCreate` — the callers all guarded on that, and the guard belongs with
 * the write.
 */
export async function persistTransactionSignals(
  transactionId: number,
  signals: readonly Signal[],
  transaction: DbTransaction,
): Promise<void> {
  if (signals.length === 0) return;
  await TransactionSignal.bulkCreate(
    signals.map((s) => ({
      transactionId,
      source: s.source,
      confidence: s.confidence,
      fields: s.fields,
      rationale: s.rationale ?? null,
    })),
    { transaction },
  );
}

/**
 * Persist the item-link match a stage found, as a suggested
 * TransactionOrderLink. Idempotent, and never resurrects a link the user has
 * already rejected, so an import and a backfill can both call it for the same
 * row. A no-op when no stage produced a match.
 */
export async function persistSuggestedOrderLink(
  transactionId: number,
  signals: readonly Signal[],
  transaction: DbTransaction,
): Promise<void> {
  const orderLink = signals.find((s) => s.orderLink)?.orderLink;
  if (!orderLink) return;
  await upsertSuggestedOrderLink({
    transactionId,
    externalOrderId: orderLink.externalOrderId,
    confidence: orderLink.confidence,
    matchReason: orderLink.matchReason,
    transaction,
  });
}
