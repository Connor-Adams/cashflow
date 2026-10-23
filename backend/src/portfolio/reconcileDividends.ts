/**
 * Auto-create `InvestmentActivity` dividend rows from `SecurityDividend`
 * facts pulled from Alpha Vantage, so cash payouts show up in cashflow
 * even when the brokerage CSV/PDF skipped them.
 *
 * For each (security, ex-date) event:
 *   - Candidate accounts are those with a HoldingSnapshot of the security
 *     at-or-before the ex-date (and no more than SNAPSHOT_STALE_MAX_DAYS
 *     before it).
 *   - Each candidate's position going into the ex-date is then re-derived by
 *     `positionOnExDate`: skipped when the account closed before the ex-date,
 *     when its newest statement omits the security (fully sold — imports
 *     write no zero-quantity tombstones), or when trades between that
 *     statement and the ex-date take the quantity to zero. A snapshot alone
 *     is only a lower-bound date for the quantity, not proof it was held on
 *     the ex-date.
 *   - Skip the account when the broker already recorded the payout
 *     (`findBrokerPayout`): a broker `dividend` row for the security, or a
 *     security-less broker distribution of about perShare × quantity,
 *     anywhere in the event's `payoutWindow` — brokers post on the PAY date,
 *     which can be weeks after the ex-date. This is the "don't double-count
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
import type { Transaction as DbTransaction } from 'sequelize';
import { Account, HoldingSnapshot, InvestmentActivity, SecurityDividend } from '../models';
import { logger } from '../observability/logger';
import * as env from '../config/env';
import { applyActivityQty } from './dailySnapshotBuilder';

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
  skippedClosedAccount: number;
  skippedSoldBeforeExDate: number;
}

export const RECONCILER_IMPORT_BATCH = 'alpha_vantage:dividends';

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

/** Why an account gets no synthetic dividend for an ex-date. */
export type DividendSkipReason = 'closed_account' | 'no_holding' | 'zero_quantity' | 'sold_before_ex_date';

export type ExDatePosition =
  | { held: true; quantity: number }
  | { held: false; reason: DividendSkipReason };

/**
 * The quantity of `securityId` the account held going into `exDate`, or why
 * it held none. Shared by the reconciler and the phantom-dividend repair so
 * the two can never disagree about which rows are legitimate.
 *
 *   1. An account closed before the ex-date holds nothing.
 *   2. The baseline is the account's newest statement at-or-before the
 *      ex-date (within SNAPSHOT_STALE_MAX_DAYS). A security absent from it
 *      was fully sold — the same inference `latestActivePositions` makes for
 *      the Portfolio page and net worth.
 *   3. Position-changing trades after that statement and before the ex-date
 *      are replayed onto the baseline (a sale on the ex-date itself still
 *      earns the dividend, so the window is exclusive of the ex-date).
 */
export async function positionOnExDate(
  accountId: number,
  securityId: number,
  exDate: string,
  t?: DbTransaction,
): Promise<ExDatePosition> {
  const account = await Account.findByPk(accountId, { attributes: ['id', 'closedAt'], transaction: t });
  if (account?.closedAt && exDate > account.closedAt) return { held: false, reason: 'closed_account' };

  const statement = await HoldingSnapshot.findOne({
    where: {
      accountId,
      statementDate: { [Op.gte]: addDays(exDate, -SNAPSHOT_STALE_MAX_DAYS), [Op.lte]: exDate },
    },
    attributes: ['statementDate'],
    order: [['statementDate', 'DESC']],
    transaction: t,
  });
  if (!statement) return { held: false, reason: 'no_holding' };
  const baselineDate = statement.statementDate;

  const snapshot = await HoldingSnapshot.findOne({
    where: { accountId, securityId, statementDate: baselineDate },
    order: [['id', 'DESC']],
    transaction: t,
  });
  const baselineQty = snapshot ? Number(snapshot.quantity) : 0;
  if (snapshot && !(Number.isFinite(baselineQty) && baselineQty > 0)) {
    return { held: false, reason: 'zero_quantity' };
  }

  const trades = await InvestmentActivity.findAll({
    where: {
      accountId,
      securityId,
      tradeDate: { [Op.gt]: baselineDate, [Op.lt]: exDate },
    },
    order: [['tradeDate', 'ASC'], ['id', 'ASC']],
    transaction: t,
  });
  const key = `${accountId}:${securityId}`;
  const qty = new Map<string, number>([[key, baselineQty]]);
  for (const trade of trades) applyActivityQty(qty, trade);
  const quantity = qty.get(key) ?? 0;
  // Sub-micro-share residue from float replay is not a position.
  if (!(quantity > 1e-6)) return { held: false, reason: 'sold_before_ex_date' };
  // DECIMAL(28,10) precision, so the replayed float prints like the column.
  return { held: true, quantity: Number(quantity.toFixed(10)) };
}

/**
 * How long after the ex-date a broker may post the payout when the event has
 * no payment date. Yahoo chart events (the dividend source in prod) never
 * carry one. Prod, 2026-10-23: broker dividends land 3-32 days after the
 * ex-date (XEQT ~5, VFV ~8, TD ~21, NVDA 28-32).
 */
export const PAYMENT_LAG_MAX_DAYS = 35;

/**
 * Relative amount tolerance when matching a security-less broker distribution
 * to perShare × quantity. Only the amount ties such a row to the security,
 * so the tolerance has to stay tight. Prod, 2026-10-23: genuine pairs differ
 * by at most 2.2% (the per-share figure is rounded, or the quantity is slightly
 * off), and no other positive security-less row came within 25%.
 */
export const SECURITY_LESS_AMOUNT_TOLERANCE = 0.05;

export interface PayoutWindow {
  from: string;
  to: string;
}

/**
 * The trade dates on which a broker row can be this event's payout: from
 * `dedupDays` before the ex-date to `dedupDays` after the payment date, or
 * `PAYMENT_LAG_MAX_DAYS` after the ex-date when no payment date is known. The
 * window closes before the security's next ex-date window opens, so a
 * monthly payer's next payout is never mistaken for this one. It never closes
 * earlier than `dedupDays` after the ex-date (the original window).
 */
export function payoutWindow(
  exDate: string,
  paymentDate: string | null,
  nextExDate: string | null,
  dedupDays: number,
): PayoutWindow {
  let to = paymentDate && paymentDate > exDate
    ? addDays(paymentDate, dedupDays)
    : addDays(exDate, paymentDate ? dedupDays : PAYMENT_LAG_MAX_DAYS);
  if (nextExDate) {
    const beforeNext = addDays(nextExDate, -dedupDays - 1);
    if (beforeNext < to) to = beforeNext;
  }
  const floor = addDays(exDate, dedupDays);
  return { from: addDays(exDate, -dedupDays), to: to < floor ? floor : to };
}

export interface BrokerPayout {
  id: number;
  /** 'dividend': a broker dividend row for the security. 'security_less': a
   * distribution the import could not tie to a security, matched on amount. */
  match: 'dividend' | 'security_less';
  tradeDate: string;
  amount: number;
}

/**
 * The broker-imported row that already records this payout, or null. Shared
 * by the reconciler and the duplicate-dividend repair. Synthetic rows never
 * count, and rows in `exclude` (already paired with another synthetic row) are
 * skipped so one broker row can't cover two payouts.
 */
export async function findBrokerPayout(
  args: {
    accountId: number;
    securityId: number;
    currency: string;
    expectedAmount: number;
    window: PayoutWindow;
    exclude?: ReadonlySet<number>;
  },
  t?: DbTransaction,
): Promise<BrokerPayout | null> {
  const base = {
    accountId: args.accountId,
    importBatch: { [Op.ne]: RECONCILER_IMPORT_BATCH },
    tradeDate: { [Op.gte]: args.window.from, [Op.lte]: args.window.to },
    ...(args.exclude?.size ? { id: { [Op.notIn]: [...args.exclude] } } : {}),
  };
  const toPayout = (row: InvestmentActivity, match: BrokerPayout['match']): BrokerPayout => ({
    id: row.id,
    match,
    tradeDate: String(row.tradeDate).slice(0, 10),
    amount: Number(row.amount),
  });

  const dividend = await InvestmentActivity.findOne({
    where: { ...base, securityId: args.securityId, activityType: 'dividend' },
    order: [['tradeDate', 'ASC'], ['id', 'ASC']],
    transaction: t,
  });
  if (dividend) return toPayout(dividend, 'dividend');

  const expected = args.expectedAmount;
  if (!(Number.isFinite(expected) && expected > 0)) return null;
  const candidates = await InvestmentActivity.findAll({
    where: {
      ...base,
      securityId: null,
      activityType: { [Op.in]: ['dividend', 'other'] },
      currency: args.currency,
      amount: {
        [Op.gte]: expected * (1 - SECURITY_LESS_AMOUNT_TOLERANCE),
        [Op.lte]: expected * (1 + SECURITY_LESS_AMOUNT_TOLERANCE),
      },
    },
    order: [['tradeDate', 'ASC'], ['id', 'ASC']],
    transaction: t,
  });
  const closest = candidates.reduce<InvestmentActivity | null>(
    (best, row) => (best == null
      || Math.abs(Number(row.amount) - expected) < Math.abs(Number(best.amount) - expected) ? row : best),
    null,
  );
  return closest ? toPayout(closest, 'security_less') : null;
}

export interface SyntheticDividend {
  row: InvestmentActivity;
  securityId: number;
  /** A synthetic row's tradeDate is the ex-date it was built for. */
  exDate: string;
  position: ExDatePosition;
}

/**
 * Every synthetic dividend row with its ex-date position, in account then
 * date order. Shared by the phantom and duplicate repairs.
 */
export async function syntheticDividendsWithPosition(t?: DbTransaction): Promise<SyntheticDividend[]> {
  const rows = await InvestmentActivity.findAll({
    where: { importBatch: RECONCILER_IMPORT_BATCH, activityType: 'dividend' },
    order: [['accountId', 'ASC'], ['tradeDate', 'ASC'], ['id', 'ASC']],
    transaction: t,
  });
  const out: SyntheticDividend[] = [];
  for (const row of rows) {
    if (row.securityId == null) continue;
    const exDate = String(row.tradeDate).slice(0, 10);
    const position = await positionOnExDate(row.accountId, row.securityId, exDate, t);
    out.push({ row, securityId: row.securityId, exDate, position });
  }
  return out;
}

/**
 * A synthetic row this reconciler already wrote for the event. Keyed on the
 * ex-date window rather than the fingerprint, which embeds the amount, so a
 * re-run after the quantity changed is still a no-op.
 */
async function existingSyntheticNearby(
  accountId: number,
  securityId: number,
  exDate: string,
  windowDays: number,
): Promise<boolean> {
  const count = await InvestmentActivity.count({
    where: {
      accountId,
      securityId,
      activityType: 'dividend',
      importBatch: RECONCILER_IMPORT_BATCH,
      tradeDate: { [Op.gte]: addDays(exDate, -windowDays), [Op.lte]: addDays(exDate, windowDays) },
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
    skippedClosedAccount: 0,
    skippedSoldBeforeExDate: 0,
  };

  const events = await SecurityDividend.findAll({
    where: { securityId },
    order: [['exDividendDate', 'ASC']],
  });
  if (events.length === 0) return result;

  for (const [i, ev] of events.entries()) {
    const window = payoutWindow(
      ev.exDividendDate,
      ev.paymentDate || null,
      events[i + 1]?.exDividendDate ?? null,
      dedupDays,
    );
    const holdings = await latestHoldingPerAccountAtOrBefore(
      securityId,
      ev.exDividendDate,
    );
    if (holdings.size === 0) {
      result.skippedNoHolding += 1;
      continue;
    }
    for (const [accountId, snapshot] of holdings) {
      const position = await positionOnExDate(accountId, securityId, ev.exDividendDate);
      if (!position.held) {
        if (position.reason === 'closed_account') result.skippedClosedAccount += 1;
        else if (position.reason === 'sold_before_ex_date') result.skippedSoldBeforeExDate += 1;
        else if (position.reason === 'zero_quantity') result.skippedZeroQuantity += 1;
        else result.skippedNoHolding += 1;
        continue;
      }
      const qty = position.quantity;
      const perShare = Number(ev.amount);
      if (!Number.isFinite(perShare) || perShare <= 0) {
        result.skippedZeroQuantity += 1;
        continue;
      }
      const totalAmount = (qty * perShare).toFixed(4);
      const conflict = await existingSyntheticNearby(accountId, securityId, ev.exDividendDate, dedupDays)
        || await findBrokerPayout({
          accountId,
          securityId,
          currency: ev.currency,
          expectedAmount: Number(totalAmount),
          window,
        });
      if (conflict) {
        result.skippedExistingBroker += 1;
        continue;
      }
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
        // `existingSyntheticNearby` above can't both INSERT and
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
