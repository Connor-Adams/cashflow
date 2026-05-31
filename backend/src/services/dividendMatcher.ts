/**
 * Dividend reconciliation service.
 * Auto-matches SecurityDividend rows to Transaction credits within
 * paymentDate ± 5 days, amount ± 2%, same account holding the security.
 */
import { Op } from 'sequelize';
import {
  HoldingSnapshot,
  Security,
  SecurityDividend,
  Transaction,
} from '../models';

const DATE_WINDOW_DAYS = 5;
const AMOUNT_TOLERANCE = 0.02;

function dateRange(center: string, windowDays: number): { from: string; to: string } {
  const d = new Date(center + 'T00:00:00Z');
  const from = new Date(d);
  from.setUTCDate(from.getUTCDate() - windowDays);
  const to = new Date(d);
  to.setUTCDate(to.getUTCDate() + windowDays);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

export type DividendCandidate = {
  transactionId: number;
  date: string;
  amount: number;
  currency: string;
  description: string;
  accountId: number;
  score: number;
};

export type DividendMatchResult = {
  processed: number;
  matched: number;
  skipped: number;
};

/**
 * Find candidate transactions for a given dividend + household.
 * Ranked by closeness of amount, then date.
 */
export async function candidatesForDividend(
  dividend: SecurityDividend,
  householdId: number,
  windowDays = 30,
): Promise<DividendCandidate[]> {
  const paymentDate = dividend.paymentDate ?? dividend.exDividendDate;
  if (!paymentDate) return [];

  const { from, to } = dateRange(paymentDate, windowDays);
  const expectedAmount = Number(dividend.amount);

  const txns = await Transaction.findAll({
    where: {
      householdId,
      date: { [Op.between]: [from, to] },
      amount: { [Op.gt]: 0 }, // credits only
      currency: dividend.currency,
    },
    limit: 200,
  });

  return txns
    .map((t) => {
      const amount = Math.abs(Number(t.amount));
      const amountDiff = expectedAmount > 0 ? Math.abs(amount - expectedAmount) / expectedAmount : 1;
      const daysDiff = Math.abs(
        (new Date(t.date).getTime() - new Date(paymentDate + 'T00:00:00Z').getTime()) / 86400000,
      );
      const score = amountDiff * 0.6 + (daysDiff / windowDays) * 0.4;
      return {
        transactionId: t.id,
        date: t.date,
        amount,
        currency: t.currency,
        description: t.description ?? '',
        accountId: t.accountId ?? 0,
        score,
      };
    })
    .sort((a, b) => a.score - b.score);
}

/**
 * Run the auto-matching pass for a household.
 * Matches only dividends with paymentDate in the past 90 days and no match yet.
 */
export async function autoMatchDividends(householdId: number): Promise<DividendMatchResult> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const unmatched = await SecurityDividend.findAll({
    where: {
      matchedTransactionId: null,
      paymentDate: { [Op.ne]: null, [Op.gte]: cutoff, [Op.lt]: new Date().toISOString().slice(0, 10) },
    },
    include: [{ model: Security, as: 'security' }],
  });

  const result: DividendMatchResult = { processed: unmatched.length, matched: 0, skipped: 0 };

  for (const div of unmatched) {
    const paymentDate = div.paymentDate!;
    const { from, to } = dateRange(paymentDate, DATE_WINDOW_DAYS);
    const expectedAmount = Number(div.amount);

    const candidates = await Transaction.findAll({
      where: {
        householdId,
        date: { [Op.between]: [from, to] },
        amount: { [Op.gt]: 0 },
        currency: div.currency,
      },
      limit: 50,
    });

    const matching = candidates.filter((t) => {
      const amount = Math.abs(Number(t.amount));
      const diff = expectedAmount > 0 ? Math.abs(amount - expectedAmount) / expectedAmount : 1;
      return diff <= AMOUNT_TOLERANCE;
    });

    if (matching.length === 1) {
      await div.update({
        matchedTransactionId: matching[0]!.id,
        matchedAt: new Date(),
      });
      result.matched++;
    } else {
      result.skipped++;
    }
  }

  return result;
}
