import type { Transaction } from 'sequelize';
import { ExternalOrder } from './ExternalOrder';

/**
 * Paranoid-safe lookup for an ExternalOrder keyed by its dedupe scope
 * (typically `{ householdId, dedupeKey }`).
 *
 * ExternalOrder is paranoid (docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md,
 * Part 5), and `external_orders_household_dedupe_unique` is a plain UNIQUE
 * index on (household_id, dedupe_key) -- it does NOT exclude soft-deleted
 * rows, so a merged loser still occupies its key. A plain `findOne` (or
 * `findOrCreate`) implicitly adds `deleted_at IS NULL`, so it would miss
 * that row entirely and then attempt an INSERT that collides with the
 * unique index -- turning a re-scan/re-import of previously merged-away
 * content into a crash instead of a no-op.
 *
 * This looks the row up INCLUDING soft-deleted ones and restores it in
 * place when found soft-deleted, so callers see it exactly as if it had
 * been found live. It does not otherwise touch the row's fields -- callers
 * apply their own create/update/skip logic afterward.
 *
 * Every ExternalOrder write site keyed on dedupeKey must use this instead of
 * `ExternalOrder.findOne`/`findOrCreate` directly: importAmazonOrders.ts,
 * scanReceipts.ts, discoverReceiptSources.ts, vendorCapture.ts,
 * routes/externalOrders.ts, demo/seedDemoData.ts.
 */
export async function findExternalOrderForDedupe(
  where: Record<string, unknown>,
  transaction?: Transaction,
): Promise<ExternalOrder | null> {
  const existing = await ExternalOrder.findOne({
    where: where as never,
    paranoid: false,
    transaction,
  });
  if (existing && existing.deletedAt != null) {
    await existing.restore({ transaction });
  }
  return existing;
}

/**
 * Drop-in, paranoid-safe replacement for `ExternalOrder.findOrCreate` keyed
 * on a dedupe scope (typically `{ householdId, dedupeKey }`). Same shape and
 * return type as `Model.findOrCreate` -- swap the call site's
 * `ExternalOrder.findOrCreate({ where, defaults, transaction })` for
 * `findOrCreateExternalOrderForDedupe({ where, defaults, transaction })` and
 * nothing else changes. See `findExternalOrderForDedupe` for why the plain
 * Sequelize method is unsafe here.
 */
export async function findOrCreateExternalOrderForDedupe(args: {
  where: Record<string, unknown>;
  defaults: Record<string, unknown>;
  transaction?: Transaction;
}): Promise<[ExternalOrder, boolean]> {
  const existing = await findExternalOrderForDedupe(args.where, args.transaction);
  if (existing) return [existing, false];
  const created = await ExternalOrder.create(args.defaults as never, {
    transaction: args.transaction,
  });
  return [created, true];
}
