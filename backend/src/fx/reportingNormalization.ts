/**
 * Reporting-currency normalization.
 *
 * Given an array of per-metric, per-currency aggregates and a target reporting
 * currency, convert each currency bucket to the reporting currency at the
 * supplied `asOf` date and return the normalized totals plus the FX rates
 * actually used.
 *
 * Determinism: the same input and the same FX lookup always produce the same
 * output. The FX lookup is dependency-injected so tests can pin rates
 * directly; production callers wire in `looseHistoricalFxLookup` from
 * `networth/aggregate.ts`.
 *
 * Why a dedicated module: the dashboard and reports endpoints already break
 * out aggregates by currency. To honor the "normalized reporting currency"
 * acceptance bullet (issue #221) we want a single, well-tested conversion
 * path that any aggregating endpoint can call.
 */

import type { FxLookup } from '../networth/unifyToCad';

export interface ReportingAggregate {
  /** Stable key for the metric (e.g. "totalSpend", "totalCredits"). */
  key: string;
  /** Native amounts keyed by ISO-3 currency code (uppercase). */
  byCurrency: Record<string, number>;
}

export interface NormalizedMetric {
  key: string;
  /** Sum in the reporting currency. */
  normalized: number;
  /** True when at least one currency bucket couldn't be converted. */
  partial: boolean;
  /** Per-currency contribution after conversion. Useful for tooltips. */
  contributions: Array<{
    currency: string;
    native: number;
    normalized: number | null;
    fxRate: number | null;
    ratedDate: string | null;
  }>;
}

export interface FxRateUsed {
  from: string;
  to: string;
  rate: number;
  ratedDate: string;
}

export interface NormalizationGap {
  currency: string;
  reason: 'fx_rate_unavailable';
}

export interface NormalizationResult {
  reportingCurrency: string;
  asOf: string;
  metrics: NormalizedMetric[];
  fxRatesUsed: FxRateUsed[];
  gaps: NormalizationGap[];
}

/**
 * Pre-resolve every distinct (currency, reportingCurrency, asOf) tuple once.
 * Cuts the work to one FX lookup per non-identity currency regardless of how
 * many metrics share the same currency.
 */
const round4 = (n: number) => Math.round(n * 10000) / 10000;

async function resolveFxRates(
  currencies: Set<string>,
  reporting: string,
  asOf: string,
  fxLookup: FxLookup
): Promise<{
  rates: Map<string, { rate: number; ratedDate: string }>;
  missing: Set<string>;
}> {
  const rates = new Map<string, { rate: number; ratedDate: string }>();
  const missing = new Set<string>();
  for (const cur of currencies) {
    if (cur === reporting) {
      rates.set(cur, { rate: 1, ratedDate: asOf });
      continue;
    }
    const fx = await fxLookup(cur, reporting, asOf);
    if (!fx) {
      missing.add(cur);
      continue;
    }
    rates.set(cur, fx);
  }
  return { rates, missing };
}

export async function normalizeToReportingCurrency(
  aggregates: ReportingAggregate[],
  reportingCurrency: string,
  asOf: string,
  fxLookup: FxLookup
): Promise<NormalizationResult> {
  const reporting = reportingCurrency.toUpperCase();

  // Collect all distinct (currency, amount) pairs that need FX. Zero-amount
  // buckets are skipped — they contribute 0 regardless of rate.
  const distinctCurrencies = new Set<string>();
  for (const agg of aggregates) {
    for (const [cur, amount] of Object.entries(agg.byCurrency)) {
      if (amount === 0) continue;
      distinctCurrencies.add(cur.toUpperCase());
    }
  }

  const { rates, missing } = await resolveFxRates(
    distinctCurrencies,
    reporting,
    asOf,
    fxLookup
  );

  const gaps: NormalizationGap[] = Array.from(missing)
    .sort()
    .map((currency) => ({ currency, reason: 'fx_rate_unavailable' as const }));

  const metrics: NormalizedMetric[] = aggregates.map((agg) => {
    const contributions: NormalizedMetric['contributions'] = [];
    let normalized = 0;
    let partial = false;
    const entries = Object.entries(agg.byCurrency).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [rawCur, amount] of entries) {
      const cur = rawCur.toUpperCase();
      if (amount === 0) {
        contributions.push({
          currency: cur,
          native: 0,
          normalized: 0,
          fxRate: cur === reporting ? 1 : null,
          ratedDate: cur === reporting ? asOf : null,
        });
        continue;
      }
      const fx = rates.get(cur);
      if (!fx) {
        partial = true;
        contributions.push({
          currency: cur,
          native: amount,
          normalized: null,
          fxRate: null,
          ratedDate: null,
        });
        continue;
      }
      const converted = round4(amount * fx.rate);
      normalized += converted;
      contributions.push({
        currency: cur,
        native: amount,
        normalized: converted,
        fxRate: fx.rate,
        ratedDate: fx.ratedDate,
      });
    }
    return { key: agg.key, normalized, partial, contributions };
  });

  // Build the FX rates used (dedup, exclude identity).
  const fxRatesUsed: FxRateUsed[] = [];
  for (const [cur, fx] of rates.entries()) {
    if (cur === reporting) continue;
    fxRatesUsed.push({ from: cur, to: reporting, rate: fx.rate, ratedDate: fx.ratedDate });
  }
  fxRatesUsed.sort((a, b) => a.from.localeCompare(b.from));

  return {
    reportingCurrency: reporting,
    asOf,
    metrics,
    fxRatesUsed,
    gaps,
  };
}
