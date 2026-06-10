import { Op } from 'sequelize';
import type { Decimal } from '../tax/util/decimal';
import { FxRate } from '../models/FxRate';
import { ensureFxRate, ENSURE_FX_CACHE_WINDOW_DAYS } from './bankOfCanada';

export type ToCadSource =
  | 'cad_identity'
  | 'cached'
  | 'fetched'
  | 'fallback_nearest'
  | 'fallback_any';

export interface ToCadResult {
  /** Amount converted to CAD. */
  cad: Decimal;
  /** The FX rate used (1 for CAD→CAD). */
  rate: number;
  /** The publication date of the rate used. */
  ratedDate: string;
  /** Where the rate came from — useful for surfacing freshness warnings. */
  source: ToCadSource;
}

/**
 * Convert an amount to CAD using a robust historical FX lookup.
 *
 * Order of attempts:
 *   1. CAD short-circuit (no DB or HTTP).
 *   2. ensureFxRate(): same-day cache + BoC API fetch + persist. Returns
 *      `cached` if hit, `fetched` if it made an HTTP call.
 *   3. Nearest FxRate row on/before the date, no staleness cap.
 *   4. Any FxRate row for the pair (even future-dated, last resort).
 *   5. Throw only if zero rows exist for the pair anywhere.
 *
 * The throw is the last-resort signal that the system truly has no data for
 * this currency. Backfill / manual seeding fixes it.
 */
export async function toCad(
  amount: Decimal,
  currency: string,
  date: string,
): Promise<ToCadResult> {
  if (currency === 'CAD') {
    return { cad: amount, rate: 1, ratedDate: date, source: 'cad_identity' };
  }

  // Snapshot the existing cached row (if any) so we can tell `cached` from
  // `fetched` after ensureFxRate returns.
  const sevenDaysAgo = subtractDays(date, ENSURE_FX_CACHE_WINDOW_DAYS);
  const preExisting = await FxRate.findOne({
    where: {
      fromCurrency: currency,
      toCurrency: 'CAD',
      ratedDate: { [Op.gte]: sevenDaysAgo, [Op.lte]: date },
    },
    order: [['ratedDate', 'DESC']],
  });

  const fresh = await ensureFxRate(currency, 'CAD', date);
  // Defensive: ensureFxRate's cache window and the BoC fetch are both bounded
  // at `date`, so ratedDate should never exceed it — but guard anyway so a
  // future-dated row can never masquerade as `cached`/`fetched` (the fallbacks
  // below would surface it as `fallback_any` instead).
  if (fresh && fresh.ratedDate <= date) {
    const source: ToCadSource =
      preExisting && preExisting.ratedDate === fresh.ratedDate ? 'cached' : 'fetched';
    return {
      cad: amount.times(String(fresh.rate)),
      rate: fresh.rate,
      ratedDate: fresh.ratedDate,
      source,
    };
  }

  // Fallback 1: nearest historical row, no staleness cap.
  const nearest = await FxRate.findOne({
    where: {
      fromCurrency: currency,
      toCurrency: 'CAD',
      ratedDate: { [Op.lte]: date },
    },
    order: [['ratedDate', 'DESC']],
  });
  if (nearest) {
    return {
      cad: amount.times(String(nearest.rate)),
      rate: Number(nearest.rate),
      ratedDate: nearest.ratedDate,
      source: 'fallback_nearest',
    };
  }

  // Fallback 2: any row for the pair (even future-dated).
  const any = await FxRate.findOne({
    where: { fromCurrency: currency, toCurrency: 'CAD' },
    order: [['ratedDate', 'DESC']],
  });
  if (any) {
    return {
      cad: amount.times(String(any.rate)),
      rate: Number(any.rate),
      ratedDate: any.ratedDate,
      source: 'fallback_any',
    };
  }

  throw new Error(
    `FX rate missing for ${currency}→CAD on/before ${date} (no rows for pair at all)`,
  );
}

function subtractDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
