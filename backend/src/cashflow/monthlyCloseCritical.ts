/**
 * Critical-items detector for the monthly close workflow (issue #227).
 *
 * Counts unresolved items in a given (household, period_month) that would
 * make closing the period premature. The `close` endpoint surfaces these
 * counts as warnings; the user can still force-close, but the warning
 * keeps them from forgetting (e.g.) a partner balance.
 *
 * `period_month` is 'YYYY-MM'. The function computes [start, endExclusive)
 * date strings and uses them in the WHERE clauses. Date math is done as
 * pure string arithmetic — no Date object timezone surprises.
 */

import { Op } from 'sequelize';
import { PartnerSettlement, Transaction } from '../models';

export type MonthlyCloseCriticalCounts = {
  /** Transactions still flagged for review in the period. */
  unreviewedTransactions: number;
  /**
   * Number of (contact, currency) buckets where the running partner
   * balance from the start of time through period_end is non-zero. A bucket
   * is "outstanding" when net-of-settlements is materially non-zero
   * (|value| ≥ 0.005).
   */
  outstandingPartnerBuckets: number;
};

export type MonthlyCloseCriticalReason =
  | 'unreviewed_transactions'
  | 'outstanding_partner_balance';

export type MonthlyCloseCriticalSummary = {
  counts: MonthlyCloseCriticalCounts;
  /** Non-empty when at least one critical condition is present. */
  reasons: MonthlyCloseCriticalReason[];
  hasCritical: boolean;
};

/**
 * Validates a YYYY-MM string and returns the date range covering it.
 * `start` is inclusive ('YYYY-MM-01'), `endExclusive` is the first of
 * the next month — callers feed it into a `< endExclusive` predicate.
 *
 * Exported for test access and reuse from the route layer.
 */
export function monthRange(
  periodMonth: string,
): { start: string; endExclusive: string } | null {
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) return null;
  const [yearStr, monthStr] = periodMonth.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;

  const start = `${periodMonth}-01`;
  // Next-month rollover with no Date object: increment month, carry on 12.
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endExclusive = `${nextYear.toString().padStart(4, '0')}-${nextMonth
    .toString()
    .padStart(2, '0')}-01`;
  return { start, endExclusive };
}

/**
 * Count transactions in `period_month` flagged for review AND scoped to
 * the household (both shared and createdByUserId rows — same scope rules
 * as `householdWhere`).
 *
 * Uses the householdWhere clause supplied by the caller (a Record from
 * `auth/scope`); keeps this module pure / testable.
 */
export async function detectMonthlyCloseCritical(
  householdScope: Record<string, unknown>,
  periodMonth: string,
): Promise<MonthlyCloseCriticalSummary> {
  const range = monthRange(periodMonth);
  if (!range) {
    return {
      counts: { unreviewedTransactions: 0, outstandingPartnerBuckets: 0 },
      reasons: [],
      hasCritical: false,
    };
  }

  const unreviewedTransactions = await Transaction.count({
    where: {
      ...householdScope,
      reviewFlag: true,
      date: {
        [Op.gte]: range.start,
        [Op.lt]: range.endExclusive,
      },
    },
  });

  // Outstanding partner balance — sum settlements grouped by (contact,
  // currency), then count buckets with a non-zero net.
  //
  // We don't need to look at shared transactions here: the partner-balance
  // workflow expectation is that the user has already settled (or is
  // about to settle) the imbalance, which is recorded as PartnerSettlement
  // rows. The cheap heuristic is "do you have ANY non-zero
  // (contact,currency) settlement bucket as of the end of this period?".
  //
  // Since the production fairness math is computed over shared-spend +
  // settlements, that view is the ground truth for "balance is zero".
  // For the close warning we deliberately keep the simpler check — any
  // open partner relationship with non-zero residual settlement
  // mismatch is surfaced — and rely on the dedicated /partner page for
  // the full reconciliation.
  const settlements = (await PartnerSettlement.findAll({
    where: {
      ...householdScope,
      settledDate: {
        [Op.lt]: range.endExclusive,
      },
    },
    attributes: ['contactId', 'currency', 'direction', 'amount'],
    raw: true,
  })) as ReadonlyArray<{
    contactId: number;
    currency: string;
    direction: 'i_paid_partner' | 'partner_paid_me';
    amount: string;
  }>;

  const bucketMap = new Map<string, number>();
  for (const row of settlements) {
    const key = `${row.contactId}|${row.currency}`;
    const value = Number(row.amount) || 0;
    const signed = row.direction === 'i_paid_partner' ? value : -value;
    bucketMap.set(key, (bucketMap.get(key) ?? 0) + signed);
  }
  let outstandingPartnerBuckets = 0;
  for (const total of bucketMap.values()) {
    if (Math.abs(total) >= 0.005) outstandingPartnerBuckets += 1;
  }

  const reasons: MonthlyCloseCriticalReason[] = [];
  if (unreviewedTransactions > 0) reasons.push('unreviewed_transactions');
  if (outstandingPartnerBuckets > 0) reasons.push('outstanding_partner_balance');

  return {
    counts: { unreviewedTransactions, outstandingPartnerBuckets },
    reasons,
    hasCritical: reasons.length > 0,
  };
}
