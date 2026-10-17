import type { ToCadResult, ToCadSource } from './toCad';

/**
 * Collects the conversions `toCad` made with a SUBSTITUTED rate and renders them
 * as warnings for a tax return.
 *
 * When no rate is on file for a transaction's date (and the Bank of Canada fetch
 * fails), `toCad` falls back to the nearest earlier row with no staleness cap
 * (`fallback_nearest`), then to the newest row for the pair even if it is dated
 * AFTER the transaction (`fallback_any`). Which rate it picks is a product
 * decision and is unchanged here; the tax builders used to destructure `{ cad }`
 * and drop `source`, so a T1/T2 computed on a months-old or future-dated rate
 * looked exactly like one computed on the day's rate.
 *
 * Conversions sharing a currency, fallback kind and substituted rate date
 * collapse into one warning listing each transaction date once.
 */
const FALLBACK_SOURCES: ReadonlySet<ToCadSource> = new Set(['fallback_nearest', 'fallback_any']);

/** How many transaction dates a single warning lists before summarising the rest. */
const MAX_LISTED_DATES = 10;

export interface FxFallbackCollector {
  /** Note one conversion. Non-fallback sources are ignored. */
  record(currency: string, txnDate: string, result: Pick<ToCadResult, 'ratedDate' | 'source'>): void;
  /** One warning per (currency, fallback kind, substituted rate date), in a stable order. */
  warnings(): string[];
}

export function createFxFallbackCollector(): FxFallbackCollector {
  const groups = new Map<
    string,
    { currency: string; source: ToCadSource; ratedDate: string; dates: Set<string> }
  >();

  return {
    record(currency, txnDate, { ratedDate, source }) {
      if (!FALLBACK_SOURCES.has(source)) return;
      const key = `${currency}|${source}|${ratedDate}`;
      let group = groups.get(key);
      if (!group) {
        group = { currency, source, ratedDate, dates: new Set() };
        groups.set(key, group);
      }
      group.dates.add(txnDate);
    },
    warnings() {
      return [...groups.keys()].sort().map((key) => {
        const g = groups.get(key)!;
        const dates = listDates([...g.dates].sort());
        const pair = `${g.currency}→CAD`;
        if (g.source === 'fallback_any') {
          return (
            `No ${pair} exchange rate on or before ${dates}; those amounts were converted at the `
            + `${g.ratedDate} rate, which is dated AFTER the transaction. Add the historical rate `
            + 'and recompute.'
          );
        }
        return (
          `No ${pair} exchange rate on file for ${dates}; those amounts were converted at the `
          + `${g.ratedDate} rate, the nearest earlier one. Check the rate and recompute.`
        );
      });
    },
  };
}

function listDates(dates: string[]): string {
  if (dates.length <= MAX_LISTED_DATES) return dates.join(', ');
  const shown = dates.slice(0, MAX_LISTED_DATES).join(', ');
  return `${shown} and ${dates.length - MAX_LISTED_DATES} more date(s)`;
}
