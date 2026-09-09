/**
 * Read-time visibility scoping for `Insight` rows.
 *
 * Detectors run household-wide with no viewer — `runDetectorsForHousehold`
 * has no request and no user context — so an `Insight` is *household* state
 * the moment it is written. But an insight derived from a transaction one
 * partner marked private leaks that transaction's existence, merchant and
 * amount through the insight's own title/description. Scoping at detection
 * time is wrong (there is no viewer to scope to, and the row is shared state);
 * scoping at READ time, per requesting user, is the fix.
 *
 * Every path that reads `Insight` rows back out for a human must run them
 * through {@link filterInsightsVisibleTo}.
 */
import type { Request } from 'express';
import { Op } from 'sequelize';
import { Transaction } from '../models';
import { isSuperadmin, visibleTransactionWhere } from '../auth/scope';
import { supportingIdsFromMetadata } from './toActionItems';

/** The subset of an `Insight` needed to resolve its backing transactions. */
export type InsightVisibilityFields = {
  entityType: string | null;
  entityId: number | null;
  metadata: unknown;
};

/**
 * The transaction ids an insight is derived from — the union of the two places
 * detectors record them:
 *
 * - `entityType === 'transaction'` → `entityId` (e.g. detectMissingReceipt)
 * - `metadata.transactionIds` (e.g. detectDuplicateTransactions), read with
 *   the existing {@link supportingIdsFromMetadata}
 *
 * An empty list means the insight is a household-level fact (cash_runway_low,
 * settlement_imbalance) with no single transaction behind it.
 */
export function backingTransactionIds(row: InsightVisibilityFields): number[] {
  const ids = new Set<number>(supportingIdsFromMetadata(row.metadata));
  if (row.entityType === 'transaction' && typeof row.entityId === 'number') {
    ids.add(row.entityId);
  }
  return [...ids];
}

/**
 * Drops the insights whose backing transactions the requesting user may not
 * see. Semantics:
 *
 * - No backing transaction ids → passes through. Household-level facts are not
 *   derived from anyone's private data.
 * - Has backing ids → kept only if EVERY one of them is visible to `req`'s
 *   user under {@link visibleTransactionWhere}. Deliberately conservative: a
 *   partially-visible insight would still leak the hidden transaction's
 *   existence and amount through its title and description, so the whole row
 *   goes. An id that resolves to nothing at all (deleted transaction) is
 *   likewise "not visible" and drops the insight.
 * - Superadmins short-circuit and see everything, matching how
 *   `visibleTransactionWhere` already special-cases them.
 *
 * Visibility is resolved in a SINGLE batched query over the union of every
 * row's backing ids — never one query per insight.
 */
export async function filterInsightsVisibleTo<T extends InsightVisibilityFields>(
  req: Request,
  rows: readonly T[],
): Promise<T[]> {
  if (isSuperadmin(req)) return [...rows];
  const backing = rows.map(backingTransactionIds);
  const allIds = [...new Set(backing.flat())];
  if (allIds.length === 0) return [...rows];

  // One query for every backing id across every row. `attributes: ['id']`
  // selects no JSON column, so there is nothing for a dialect to mis-parse.
  const visibleRows = await Transaction.findAll({
    where: { ...visibleTransactionWhere(req), id: { [Op.in]: allIds } },
    attributes: ['id'],
  });
  const visibleIds = new Set<number>(visibleRows.map((t) => t.id));

  return rows.filter((_row, i) => backing[i].every((id) => visibleIds.has(id)));
}
