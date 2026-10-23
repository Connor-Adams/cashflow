/**
 * Find, and optionally remove, Alpha Vantage synthetic dividend rows that
 * duplicate a payout the broker already recorded. Before the payout-window
 * dedupe, the reconciler only looked for a broker `dividend` row within
 * ±dedupDays of the ex-date. So it missed broker rows posted on the pay date,
 * weeks later, and security-less distributions (statement imports write
 * those as `other` with no security).
 *
 * The match is `findBrokerPayout` over the reconciler's own `payoutWindow`, so
 * the repair cannot drift from what the reconciler now refuses to write. A
 * row whose holding fails `positionOnExDate` is left to the phantom-dividend
 * repair, so the two plans never overlap and each `--expect` holds whichever
 * runs first.
 *
 * The fix depends on what the broker row is:
 *   - a broker `dividend`: the synthetic row is deleted.
 *   - a security-less distribution: no income report reads `other` rows, so
 *     deleting the synthetic row alone would drop the income entirely. The
 *     broker row is retyped to `dividend` and given the synthetic row's
 *     security first. It keeps its own date (the pay date) and amount.
 */
import type { Transaction as DbTransaction } from 'sequelize';
import { Op } from 'sequelize';
import { InvestmentActivity, SecurityDividend } from '../models';
import * as env from '../config/env';
import { runPlannedWrites } from '../import/plannedWrites';
import {
  findBrokerPayout,
  payoutWindow,
  RECONCILER_IMPORT_BATCH,
  syntheticDividendsWithPosition,
  type BrokerPayout,
} from './reconcileDividends';

export interface DuplicateDividend {
  id: number;
  accountId: number;
  securityId: number;
  exDate: string;
  amount: number;
  currency: string;
  broker: BrokerPayout;
}

/** Every synthetic dividend row whose payout a broker row already records. */
export async function scanDuplicateDividends(t?: DbTransaction): Promise<DuplicateDividend[]> {
  const claimed = new Set<number>();
  const out: DuplicateDividend[] = [];
  for (const { row: r, securityId, exDate, position } of await syntheticDividendsWithPosition(t)) {
    if (!position.held) continue;

    const event = await SecurityDividend.findOne({
      where: { securityId, exDividendDate: exDate },
      transaction: t,
    });
    const next = await SecurityDividend.findOne({
      where: { securityId, exDividendDate: { [Op.gt]: exDate } },
      order: [['exDividendDate', 'ASC']],
      transaction: t,
    });
    const paymentDate = event?.paymentDate || (r.settlementDate ? String(r.settlementDate).slice(0, 10) : null);
    const broker = await findBrokerPayout({
      accountId: r.accountId,
      securityId,
      currency: r.currency,
      expectedAmount: Number(r.amount),
      window: payoutWindow(exDate, paymentDate, next?.exDividendDate ?? null, env.dividendDedupDays),
      exclude: claimed,
    }, t);
    if (!broker) continue;
    claimed.add(broker.id);
    out.push({
      id: r.id,
      accountId: r.accountId,
      securityId,
      exDate,
      amount: Number(r.amount),
      currency: r.currency,
      broker,
    });
  }
  return out;
}

/**
 * Apply the whole plan in one SQL transaction. It re-scans inside the
 * transaction, aborts on an `expect` mismatch, and rolls back unless nothing
 * is left due afterwards.
 */
export async function removeDuplicateDividends(
  opts: { expect?: number | null } = {},
): Promise<{ removed: number }> {
  const { written } = await runPlannedWrites({
    plan: scanDuplicateDividends,
    expect: opts.expect,
    write: async (d, t) => {
      if (d.broker.match === 'security_less') {
        const [retyped] = await InvestmentActivity.update(
          { activityType: 'dividend', securityId: d.securityId },
          {
            where: {
              id: d.broker.id,
              securityId: null,
              importBatch: { [Op.ne]: RECONCILER_IMPORT_BATCH },
            },
            transaction: t,
          },
        );
        if (retyped !== 1) throw new Error(`broker row #${d.broker.id} changed under the repair`);
      }
      await InvestmentActivity.destroy({
        where: { id: d.id, importBatch: RECONCILER_IMPORT_BATCH },
        transaction: t,
      });
    },
  });
  return { removed: written };
}
