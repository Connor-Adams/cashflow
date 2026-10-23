/**
 * Find, and optionally delete, Alpha Vantage synthetic dividend rows the
 * reconciler should never have written: the account was closed, had fully
 * sold the security, or traded down to zero before the ex-date.
 *
 * The decision is `positionOnExDate`, the same check the reconciler now runs
 * before inserting, so the repair cannot drift from it. Only rows carrying the
 * reconciler's import batch are considered — broker-imported dividends are
 * never touched. A synthetic row's tradeDate is the ex-date it was built for.
 */
import type { Transaction as DbTransaction } from 'sequelize';
import { InvestmentActivity } from '../models';
import { runPlannedWrites } from '../import/plannedWrites';
import { positionOnExDate, RECONCILER_IMPORT_BATCH, type DividendSkipReason } from './reconcileDividends';

export interface PhantomDividend {
  id: number;
  accountId: number;
  securityId: number;
  exDate: string;
  amount: number;
  currency: string;
  reason: DividendSkipReason;
}

/** Every synthetic dividend row that fails the ex-date position rule. */
export async function scanPhantomDividends(t?: DbTransaction): Promise<PhantomDividend[]> {
  const rows = await InvestmentActivity.findAll({
    where: { importBatch: RECONCILER_IMPORT_BATCH, activityType: 'dividend' },
    order: [['accountId', 'ASC'], ['tradeDate', 'ASC'], ['id', 'ASC']],
    transaction: t,
  });
  const out: PhantomDividend[] = [];
  for (const r of rows) {
    if (r.securityId == null) continue;
    const exDate = String(r.tradeDate).slice(0, 10);
    const position = await positionOnExDate(r.accountId, r.securityId, exDate, t);
    if (position.held) continue;
    out.push({
      id: r.id,
      accountId: r.accountId,
      securityId: r.securityId,
      exDate,
      amount: Number(r.amount),
      currency: r.currency,
      reason: position.reason,
    });
  }
  return out;
}

/**
 * Delete every phantom row in one SQL transaction. Re-scans inside it; aborts
 * on an `expect` mismatch and rolls back unless nothing is left to delete.
 */
export async function deletePhantomDividends(opts: { expect?: number | null } = {}): Promise<{ deleted: number }> {
  const { written } = await runPlannedWrites({
    plan: scanPhantomDividends,
    expect: opts.expect,
    write: async (p, t) => {
      await InvestmentActivity.destroy({
        where: { id: p.id, importBatch: RECONCILER_IMPORT_BATCH },
        transaction: t,
      });
    },
  });
  return { deleted: written };
}
