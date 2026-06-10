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
import { PartnerSettlement, Transaction, sequelize } from '../models';
import {
  applySettlements,
  type RawPartnerRow,
  type SettlementSummary,
} from '../summary/partnerMath';
import { num } from '../util/numbers';

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

  // Outstanding partner balance — same ground truth as the /api/summary
  // /partner endpoint (`partnerMath.applySettlements`): per (contact,
  // currency) bucket, net = rawNet(shared spend) + settledAmount
  // (iPaid − partnerPaid), computed from the start of time through
  // period_end. Summing settlement rows alone is wrong in both
  // directions: unsettled shared spend with no settlement rows would
  // never warn, and any one-directional settlement that squares a real
  // balance would warn forever after.
  const [spendRows, settlements] = await Promise.all([
    Transaction.findAll({
      where: {
        ...householdScope,
        date: {
          [Op.lt]: range.endExclusive,
        },
      },
      attributes: [
        'currency',
        'ownershipContactId',
        [
          sequelize.fn('SUM', sequelize.col('partner_share_amount')),
          'sumPartner',
        ],
      ],
      group: ['currency', 'ownershipContactId'],
      raw: true,
    }) as unknown as Promise<
      ReadonlyArray<{
        currency: string;
        ownershipContactId: number | null;
        sumPartner: unknown;
      }>
    >,
    PartnerSettlement.findAll({
      where: {
        ...householdScope,
        settledDate: {
          [Op.lt]: range.endExclusive,
        },
      },
      attributes: ['contactId', 'currency', 'direction', 'amount'],
      raw: true,
    }) as unknown as Promise<
      ReadonlyArray<{
        contactId: number;
        currency: string;
        direction: 'i_paid_partner' | 'partner_paid_me';
        amount: string;
      }>
    >,
  ]);

  const settlementByKey = new Map<string, SettlementSummary>();
  for (const row of settlements) {
    const amount = num(row.amount) ?? 0;
    const key = `${row.contactId}\0${row.currency}`;
    const existing = settlementByKey.get(key) ?? {
      contactId: row.contactId,
      currency: row.currency,
      iPaid: 0,
      partnerPaid: 0,
    };
    if (row.direction === 'i_paid_partner') existing.iPaid += amount;
    else existing.partnerPaid += amount;
    settlementByKey.set(key, existing);
  }

  const rawRows: RawPartnerRow[] = spendRows.map((r) => ({
    currency: r.currency,
    // Buckets are already collapsed per (contact, currency); the ownership
    // type does not enter the net math (see partnerMath.rawNetForRow).
    ownershipType: 'aggregate',
    ownershipContactId: r.ownershipContactId,
    contactName: null,
    sumMy: null,
    sumPartner: num(r.sumPartner),
  }));

  const adjusted = applySettlements(
    rawRows,
    Array.from(settlementByKey.values()),
  );
  let outstandingPartnerBuckets = 0;
  for (const row of adjusted) {
    if (Math.abs(row.net) >= 0.005) outstandingPartnerBuckets += 1;
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
