import type { Transaction } from 'sequelize';
import { Account } from '../models/Account';

/**
 * Shared plumbing for the portfolio cache-invalidation hooks
 * (dailySnapshotStaleHooks, forwardIncomeStaleHooks).
 *
 * Those hooks fire on a ledger write (an InvestmentActivity, HoldingSnapshot or
 * SecurityDividend row) and invalidate a derived portfolio cache. The
 * invalidation runs INSIDE the transaction that made the ledger write, never on
 * the global connection and never from an `afterCommit` callback:
 *
 * - Atomicity. The cache mark commits or rolls back with the ledger change. A
 *   failed import leaves neither its rows nor a cache invalidation behind, and a
 *   committed one can never leave the cache un-invalidated.
 *
 * - No self-inflicted lock wait. Until this module existed the hooks deferred
 *   the work with `opts.transaction.afterCommit(...)` and ran it on the global
 *   connection. The statement importer inserts every row inside a SAVEPOINT
 *   (`sequelize.transaction({ transaction: t }, ...)`), and Sequelize v6 fires a
 *   savepoint's afterCommit hooks — and awaits them — when the SAVEPOINT is
 *   released, while the outer import transaction is still open. On SQLite the
 *   deferred write then waited on the import's own write lock (busy_timeout
 *   5s, retried 5 times by Sequelize's default SQLITE_BUSY retry) before failing
 *   silently — ~25s per imported row. On Postgres it ran on a second pooled
 *   connection before the import committed, so the invalidation survived a
 *   rolled-back import and could be undone by a rebuild that read the
 *   pre-import ledger.
 *
 * Invalidation is a single indexed UPDATE/DELETE scoped to one household, so
 * holding its row locks until the ledger transaction commits is cheap — and a
 * concurrent rebuild that wants those rows correctly waits for the new ledger.
 */
export type HookOptions = { transaction?: Transaction | null };

/** The transaction the hooked write ran in, or undefined for an autocommit write. */
export function hookTransaction(opts: unknown): Transaction | undefined {
  return (opts as HookOptions | undefined)?.transaction ?? undefined;
}

/**
 * The row's household — its own column when set, else its account's. The
 * account lookup reads through the hooked write's transaction.
 */
export async function householdIdForRow(
  row: { householdId?: number | null; accountId: number },
  transaction: Transaction | undefined,
): Promise<number | null> {
  if (row.householdId != null) return row.householdId;
  const acct = await Account.findByPk(row.accountId, {
    attributes: ['householdId'],
    ...(transaction ? { transaction } : {}),
  });
  return acct?.householdId ?? null;
}
