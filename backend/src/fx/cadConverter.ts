import { looseHistoricalFxLookup } from '../networth/aggregate';
import type { FxLookup } from '../networth/unifyToCad';
import { toUnits, fromUnits } from '../util/numbers';

/**
 * Converts a native amount into CAD at a fixed `asOf`, or returns null when no
 * rate for the currency can be resolved (callers exclude + flag those rather
 * than silently summing a foreign amount as if it were CAD).
 */
export type CadConverter = (amount: number, currency: string) => Promise<number | null>;

/**
 * Build a memoised amount→CAD converter for one as-of date. Uses the same loose
 * historical FX lookup net worth and card utilization use; injectable for tests.
 * Results are rounded to the DB's 4-dp precision so 2000 × 1.4 is exactly 2800.
 */
export function makeCadConverter(
  asOf: string,
  fxLookup: FxLookup = looseHistoricalFxLookup,
): CadConverter {
  const rates = new Map<string, Promise<number | null>>();
  const rateFor = (currency: string): Promise<number | null> => {
    const ccy = currency.toUpperCase();
    let rate = rates.get(ccy);
    if (!rate) {
      rate = ccy === 'CAD'
        ? Promise.resolve(1)
        : fxLookup(ccy, 'CAD', asOf).then((fx) => (fx ? fx.rate : null));
      rates.set(ccy, rate);
    }
    return rate;
  };
  return async (amount, currency) => {
    const rate = await rateFor(currency);
    return rate == null ? null : fromUnits(toUnits(amount * rate));
  };
}
