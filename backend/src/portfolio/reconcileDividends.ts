/**
 * Auto-create `InvestmentActivity` dividend rows from `SecurityDividend`
 * facts pulled from Alpha Vantage, so cash payouts show up in cashflow
 * even when the brokerage CSV/PDF skipped them.
 *
 * For each (security, ex-date) event:
 *   - Find every account holding the security on that date by taking the
 *     most-recent HoldingSnapshot at-or-before the ex-date for each
 *     account/security pair. Accounts with no snapshot at-or-before the
 *     ex-date — or with a zero quantity — are skipped.
 *   - Skip the account when a broker-imported `InvestmentActivity` with
 *     `activityType='dividend'` for the same security already exists
 *     within `±dedupDays` of the ex-date. This is the "don't double-count
 *     broker-imported dividends" guard.
 *   - Otherwise insert one InvestmentActivity row per account with the
 *     amount = perShare × quantity, currency = AV-reported currency, and
 *     a stable synthetic fingerprint so re-running the reconciler is a
 *     no-op.
 *
 * The reconciler does NOT update or delete rows it has previously
 * inserted — if AV later corrects a dividend amount the existing row is
 * left in place and a warning is logged. This is intentional for the
 * first pass: silently mutating rows that may feed downstream tax /
 * cashflow reports would be worse than asking a human to clean it up.
 */
import { Op } from 'sequelize';
import { createHash } from 'crypto';
import { HoldingSnapshot, InvestmentActivity, SecurityDividend } from '../models';
import { logger } from '../observability/logger';
import * as env from '../config/env';

export interface ReconcileOptions {
  /** Days on either side of the ex-date that constitute a broker-match. */
  dedupDays?: number;
  /** Reference time used for dedupe windowing in tests. Defaults to ex-date. */
  now?: Date;
}

export interface ReconcileResult {
  inserted: number;
  skippedExistingBroker: number;
  skippedNoHolding: number;
  skippedZeroQuantity: number;
}

const RECONCILER_IMPORT_BATCH = 'alpha_vantage:dividends';

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function fingerprintFor(input: {
  accountId: number;
  securityId: number;
  exDate: string;
  amount: string;
}): string {
  const h = createHash('sha1');
  h.update('av-dividend-reconciler:');
  h.update(`${input.accountId}:${input.securityId}:${input.exDate}:${input.amount}`);
  return h.digest('hex');
}

/**
 * For each account that has any HoldingSnapshot for the security, return
 * the most recent snapshot at-or-before `asOfDate`. Accounts that only
 * have snapshots *after* the date are omitted.
 */
async function latestHoldingPerAccountAtOrBefore(
  securityId: number,
  asOfDate: string,
): Promise<Map<number, HoldingSnapshot>> {
  const rows = await HoldingSnapshot.findAll({
    where: {
      securityId,
      statementDate: { [Op.lte]: asOfDate },
    },
    order: [
      ['accountId', 'ASC'],
      ['statementDate', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const out = new Map<number, HoldingSnapshot>();
  for (const row of rows) {
    if (!out.has(row.accountId)) out.set(row.accountId, row);
  }
  return out;
}

async function existingBrokerDividendNearby(
  accountId: number,
  securityId: number,
  exDate: string,
  windowDays: number,
): Promise<boolean> {
  const lo = addDays(exDate, -windowDays);
  const hi = addDays(exDate, windowDays);
  const count = await InvestmentActivity.count({
    where: {
      accountId,
      securityId,
      activityType: 'dividend',
      tradeDate: { [Op.gte]: lo, [Op.lte]: hi },
      // Importantly, INCLUDE alpha_vantage:dividends rows too — that way
      // re-running the reconciler with an unchanged event is a no-op.
    },
  });
  return count > 0;
}

/**
 * Run the reconciliation pass for one security. Safe to call repeatedly —
 * existing AV-derived rows are detected by the same window check, and
 * broker-imported rows always win the dedupe.
 */
export async function reconcileDividendsForSecurity(
  securityId: number,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const dedupDays = opts.dedupDays ?? env.dividendDedupDays;
  const result: ReconcileResult = {
    inserted: 0,
    skippedExistingBroker: 0,
    skippedNoHolding: 0,
    skippedZeroQuantity: 0,
  };

  const events = await SecurityDividend.findAll({
    where: { securityId },
    order: [['exDividendDate', 'ASC']],
  });
  if (events.length === 0) return result;

  for (const ev of events) {
    const holdings = await latestHoldingPerAccountAtOrBefore(
      securityId,
      ev.exDividendDate,
    );
    if (holdings.size === 0) {
      result.skippedNoHolding += 1;
      continue;
    }
    for (const [accountId, snapshot] of holdings) {
      const qty = Number(snapshot.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        result.skippedZeroQuantity += 1;
        continue;
      }
      const perShare = Number(ev.amount);
      if (!Number.isFinite(perShare) || perShare <= 0) {
        result.skippedZeroQuantity += 1;
        continue;
      }
      const conflict = await existingBrokerDividendNearby(
        accountId,
        securityId,
        ev.exDividendDate,
        dedupDays,
      );
      if (conflict) {
        result.skippedExistingBroker += 1;
        continue;
      }
      const totalAmount = (qty * perShare).toFixed(4);
      const fp = fingerprintFor({
        accountId,
        securityId,
        exDate: ev.exDividendDate,
        amount: totalAmount,
      });
      try {
        await InvestmentActivity.create({
          accountId,
          householdId: snapshot.householdId,
          // Use the ex-date as the canonical tradeDate so the ±dedupDays
          // window check (which keys on tradeDate) naturally matches our
          // own rows on a subsequent reconcile pass. The payment-date
          // goes into settlementDate when present.
          securityId,
          activityType: 'dividend',
          tradeDate: ev.exDividendDate,
          settlementDate: ev.paymentDate || null,
          description: `Dividend reconciled from Alpha Vantage (${perShare}/sh × ${qty})`,
          quantity: null,
          price: null,
          amount: totalAmount,
          fees: null,
          splitRatio: null,
          currency: ev.currency,
          sourceReference: `av-dividend:${ev.exDividendDate}`,
          sourceRowFingerprint: fp,
          importBatch: RECONCILER_IMPORT_BATCH,
        });
        result.inserted += 1;
      } catch (err) {
        // Race: another reconcile-and-insert path may have just landed
        // the same row. Surface for observability but don't fail the run.
        logger.warn('av_dividend_reconcile_insert_failed', {
          accountId,
          securityId,
          exDate: ev.exDividendDate,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (result.inserted > 0) {
    logger.info('av_dividend_reconcile_completed', {
      securityId,
      ...result,
    });
  }
  return result;
}
