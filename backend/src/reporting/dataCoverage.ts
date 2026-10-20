/**
 * How much of a trailing reporting window the household's imported data
 * actually covers, so /api/v1 burn and income rates are averaged over the
 * days with data rather than a flat "90 days ÷ 3". A stale import (nothing
 * since six weeks ago) or a household whose data starts mid-window would
 * otherwise read as a fraction of its real monthly rate.
 */
import { Op, fn, col } from 'sequelize';
import { Transaction } from '../models';

/** Average Gregorian month length (365.25 / 12), the normalization unit. */
export const DAYS_PER_MONTH = 30.44;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type TxnSpan = {
  /** Household's earliest transaction date (YYYY-MM-DD), any account. */
  first: string | null;
  /** Household's latest transaction date on/before the as-of day, any account. */
  latest: string | null;
};

/**
 * Months of data inside a window opening at `windowStart`: from the window
 * start (or the household's first transaction, if later) through its latest
 * transaction, inclusive, in 30.44-day months. Null when nothing falls in the
 * window — there is no rate to report.
 */
export function coveredMonths(windowStart: string, span: TxnSpan): number | null {
  if (span.latest == null || span.latest < windowStart) return null;
  const start = span.first != null && span.first > windowStart ? span.first : windowStart;
  const days = Math.round((Date.parse(span.latest) - Date.parse(start)) / MS_PER_DAY) + 1;
  return days > 0 ? days / DAYS_PER_MONTH : null;
}

/** `total` per covered month, rounded to cents; null when there is no coverage. */
export function perMonth(total: number, months: number | null): number | null {
  if (months == null) return null;
  return Math.round((total / months) * 100) / 100;
}

/** Earliest and latest (on/before `asOf`) transaction dates across the household. */
export async function householdTxnSpan(householdId: number, asOf: string): Promise<TxnSpan> {
  const [firstRow, latestRow] = await Promise.all([
    Transaction.findOne({
      where: { householdId },
      attributes: [[fn('MIN', col('date')), 'd']],
      raw: true,
    }),
    Transaction.findOne({
      where: { householdId, date: { [Op.lte]: asOf } },
      attributes: [[fn('MAX', col('date')), 'd']],
      raw: true,
    }),
  ]);
  return { first: toIsoDate(firstRow), latest: toIsoDate(latestRow) };
}

function toIsoDate(row: unknown): string | null {
  const d = (row as { d?: string | Date | null } | null)?.d;
  if (d == null) return null;
  return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
}
