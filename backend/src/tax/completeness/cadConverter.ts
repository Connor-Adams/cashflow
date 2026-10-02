import { D, type Decimal } from '../util/decimal';
import { toCad } from '../../fx/toCad';
import { logger } from '../../observability/logger';

/**
 * A per-invocation CAD converter that never makes the same lookup twice and never
 * takes the response down.
 *
 * Two problems it solves, both from calling `toCad` directly in a loop:
 *
 * `toCad` is not cheap — an `FxRate` lookup plus `ensureFxRate`, which can make a Bank
 * of Canada HTTP call. The completeness report and the forward view both converted per
 * row, sequentially, on a route whose report is recomputed on EVERY request including
 * cache hits. Prod holds 30 USD transfers in 2026, so that was 30+ serial round trips
 * for figures that share a handful of distinct currency/date pairs. Memoising on that
 * pair collapses them.
 *
 * And `toCad` throws when no rate exists for a pair anywhere. Neither caller caught it,
 * so a missing rate would 500 the whole T1 response — for an advisory overlay. Here it
 * degrades instead: the raw amount is used, which understates a foreign figure rather
 * than hiding the return.
 */
export function createCadConverter(options: {
  /** Called once per currency/date pair that has no rate, so a caller can surface it. */
  onUnavailable?: (currency: string, date: string) => void;
} = {}): (
  amount: Decimal,
  currency: string,
  date: string,
) => Promise<Decimal> {
  const cache = new Map<string, Promise<Decimal | null>>();

  return async (amount, currency, date) => {
    if (currency === 'CAD') return amount;
    const key = `${currency}|${date}`;
    let rate = cache.get(key);
    if (rate === undefined) {
      // Cache the RATE per unit, not the converted amount — several rows share a pair
      // with different amounts.
      rate = toCad(D('1'), currency, date)
        .then((r) => r.cad)
        .catch((err: unknown) => {
          logger.warn(
            { err, currency, date },
            'completeness_fx_unavailable: using the unconverted amount',
          );
          options.onUnavailable?.(currency, date);
          return null;
        });
      cache.set(key, rate);
    }
    const perUnit = await rate;
    return perUnit === null ? amount : amount.times(perUnit);
  };
}
