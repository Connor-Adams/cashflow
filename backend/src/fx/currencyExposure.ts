/**
 * Currency exposure aggregator.
 *
 * Given a list of transactions and a target reporting currency, computes a
 * per-currency summary normalized via the supplied FX lookup. Pure function
 * — the FX lookup is injected so this module can be tested without a DB.
 *
 * "Exposure" here means: how much of the household's cash-flow activity is
 * in each currency, both in native units and normalized to a single reporting
 * currency. Used to power a dashboard panel and the /api/fx/exposure route.
 *
 * Determinism: the FX rate used for each currency is fetched at the supplied
 * `asOf` date once and applied uniformly to every txn in that currency. This
 * preserves cross-row comparability and matches the per-day batch sequencing
 * used by net-worth aggregation (see backend/src/networth/aggregate.ts).
 */

import type { FxLookup } from '../networth/unifyToCad';
import { num } from '../util/numbers';

export interface ExposureTxnRow {
  currency: string;
  /** Amount stored as a DECIMAL string in the DB; parsed via `num()`. */
  amount: string | number | null | undefined;
  /** YYYY-MM-DD — currently unused but retained so callers can extend to
   * per-day rate lookups without API churn. */
  date: string;
}

export interface CurrencyExposureRow {
  currency: string;
  transactionCount: number;
  /** Signed sum of native amounts (credits − debits). */
  sumNative: number;
  /** Sum of absolute values of native amounts (volume). */
  absSumNative: number;
  /** Native amount converted to the reporting currency, or null on FX gap. */
  cadEquivalent: number | null;
  /** Share of total converted volume — abs amounts, so offsetting flows in a
   * currency don't cancel its share (0..1). NaN-safe → 0 when the total is 0
   * or the currency has no rate. */
  shareOfTotal: number;
  /** The FX rate used for this currency → reporting currency. 1 for identity,
   * null when no rate could be resolved. */
  fxRate: number | null;
  /** Effective rate date (the BoC publication date used). */
  ratedDate: string | null;
}

export interface CurrencyExposureGap {
  currency: string;
  reason: 'fx_rate_unavailable';
}

export interface CurrencyExposureResult {
  reportingCurrency: string;
  asOf: string;
  totalCadEquivalent: number;
  byCurrency: CurrencyExposureRow[];
  gaps: CurrencyExposureGap[];
}

interface RawBucket {
  currency: string;
  transactionCount: number;
  sumNative: number;
  absSumNative: number;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

function aggregateByCurrency(txns: ExposureTxnRow[]): Map<string, RawBucket> {
  const out = new Map<string, RawBucket>();
  for (const txn of txns) {
    const cur = (txn.currency ?? '').toUpperCase().trim();
    if (!cur) continue;
    const amount = num(txn.amount) ?? 0;
    const bucket = out.get(cur) ?? {
      currency: cur,
      transactionCount: 0,
      sumNative: 0,
      absSumNative: 0,
    };
    bucket.transactionCount += 1;
    bucket.sumNative += amount;
    bucket.absSumNative += Math.abs(amount);
    out.set(cur, bucket);
  }
  return out;
}

/**
 * Convert per-currency aggregates to the reporting currency.
 *
 * On any FX gap the row keeps its native data but `cadEquivalent` is null
 * and the gap is collected for the caller to surface to users.
 */
export async function computeCurrencyExposure(
  txns: ExposureTxnRow[],
  asOf: string,
  reportingCurrency: string,
  fxLookup: FxLookup
): Promise<CurrencyExposureResult> {
  const reporting = reportingCurrency.toUpperCase();
  const buckets = aggregateByCurrency(txns);
  const rows: CurrencyExposureRow[] = [];
  const gaps: CurrencyExposureGap[] = [];

  // First pass: resolve FX rates and reporting-currency amounts.
  let totalReportingAbs = 0;
  for (const bucket of buckets.values()) {
    if (bucket.currency === reporting) {
      rows.push({
        currency: bucket.currency,
        transactionCount: bucket.transactionCount,
        sumNative: bucket.sumNative,
        absSumNative: bucket.absSumNative,
        cadEquivalent: bucket.sumNative,
        shareOfTotal: 0, // computed in pass 2
        fxRate: 1,
        ratedDate: asOf,
      });
      totalReportingAbs += bucket.absSumNative;
      continue;
    }

    const fx = await fxLookup(bucket.currency, reporting, asOf);
    if (!fx) {
      gaps.push({ currency: bucket.currency, reason: 'fx_rate_unavailable' });
      rows.push({
        currency: bucket.currency,
        transactionCount: bucket.transactionCount,
        sumNative: bucket.sumNative,
        absSumNative: bucket.absSumNative,
        cadEquivalent: null,
        shareOfTotal: 0,
        fxRate: null,
        ratedDate: null,
      });
      continue;
    }

    const converted = round4(bucket.sumNative * fx.rate);
    rows.push({
      currency: bucket.currency,
      transactionCount: bucket.transactionCount,
      sumNative: bucket.sumNative,
      absSumNative: bucket.absSumNative,
      cadEquivalent: converted,
      shareOfTotal: 0,
      fxRate: fx.rate,
      ratedDate: fx.ratedDate,
    });
    totalReportingAbs += round4(bucket.absSumNative * fx.rate);
  }

  // Second pass: compute shareOfTotal once we know the total. Shares are
  // built from converted VOLUME (absSumNative, sum of |amount|), not the net,
  // so a credit + a debit in the same currency don't cancel into 0%.
  for (const row of rows) {
    if (row.cadEquivalent == null || row.fxRate == null) {
      row.shareOfTotal = 0;
      continue;
    }
    const absVolume = round4(row.absSumNative * row.fxRate);
    row.shareOfTotal = totalReportingAbs > 0 ? absVolume / totalReportingAbs : 0;
  }

  // Stable ordering: largest absolute share first (so the dashboard shows the
  // dominant currency on top), unrated currencies last alphabetically.
  rows.sort((a, b) => {
    if (a.cadEquivalent == null && b.cadEquivalent != null) return 1;
    if (a.cadEquivalent != null && b.cadEquivalent == null) return -1;
    if (a.cadEquivalent == null && b.cadEquivalent == null) {
      return a.currency.localeCompare(b.currency);
    }
    return b.shareOfTotal - a.shareOfTotal;
  });

  const totalCadEquivalent = rows.reduce(
    (acc, r) => acc + (r.cadEquivalent ?? 0),
    0
  );

  return {
    reportingCurrency: reporting,
    asOf,
    totalCadEquivalent,
    byCurrency: rows,
    gaps,
  };
}
