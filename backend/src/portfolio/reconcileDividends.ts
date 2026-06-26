/**
 * Auto-create `InvestmentActivity` dividend rows from `SecurityDividend`
 * facts pulled from Alpha Vantage, so cash payouts show up in cashflow
 * even when the brokerage CSV/PDF skipped them.
 *
 * For each (security, ex-date) event:
 *   - Find every account holding the security on that date by taking the
 *     most-recent HoldingSnapshot at-or-before the ex-date (and no more than
 *     SNAPSHOT_STALE_MAX_DAYS before it) for each account/security pair.
 *     Accounts with no snapshot in that window — or with a zero quantity —
 *     are skipped.
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

/**
 * Maximum age (in days) of a HoldingSnapshot relative to the dividend ex-date
 * before its quantity is too stale to fabricate a synthetic dividend from.
 * Statements arrive monthly/quarterly, so ~100 days comfortably covers a
 * quarterly cadence with holiday gaps while rejecting year-old positions that
 * may have been fully sold. Mirrors the windowed cache lookups elsewhere
 * (bankOfCanada ensureFxRate, balanceAtDate) which bound lookback rather than
 * carrying an unbounded stale value forward.
 */
const SNAPSHOT_STALE_MAX_DAYS = 100;

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
  // Lower-bound the window so a year-old snapshot doesn't fabricate a phantom
  // dividend from a quantity the account may no longer hold. Upper bound stays
  // at the ex-date; only snapshots within SNAPSHOT_STALE_MAX_DAYS before it
  // count.
  const staleFloor = addDays(asOfDate, -SNAPSHOT_STALE_MAX_DAYS);
  const rows = await HoldingSnapshot.findAll({
    where: {
      securityId,
      statementDate: { [Op.gte]: staleFloor, [Op.lte]: asOfDate },
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
        // `findOrCreate` is atomic on the unique
        // (account_id, source_row_fingerprint) index, so two overlapping
        // reconcile passes (request + scheduler) that both COUNT 0 in
        // `existingBrokerDividendNearby` above can't both INSERT and
        // double-count the synthetic dividend as income. The loser of the
        // race re-reads the existing row and `created` is false, so
        // `result.inserted` only counts the row we actually wrote. This
        // replaces the prior create-then-catch, where the catch merely
        // logged and the run kept whatever `inserted` it had already
        // bumped (issue #847). The fingerprint embeds accountId, so the
        // `where` is exactly the unique-index tuple.
        const [, created] = await InvestmentActivity.findOrCreate({
          where: { accountId, sourceRowFingerprint: fp },
          defaults: {
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
          },
        });
        if (created) result.inserted += 1;
      } catch (err) {
        // Defensive: findOrCreate already serializes on the unique index,
        // so a throw here is unexpected (e.g. a transient DB error).
        // Surface for observability but don't fail the whole run.
        logger.warn({
          accountId,
          securityId,
          exDate: ev.exDividendDate,
          error: err instanceof Error ? err.message : String(err),
        }, 'av_dividend_reconcile_insert_failed');
      }
    }
  }

  if (result.inserted > 0) {
    logger.info({
      securityId,
      ...result,
    }, 'av_dividend_reconcile_completed');
  }
  return result;
}
