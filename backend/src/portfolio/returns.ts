export interface DailyPoint {
  date: string;
  marketValueCad: number;
  cashFlowCad: number;
}

export function computeTwr(points: DailyPoint[]): number {
  // Drop trailing zero-market-value points. A trailing 0 is a stale/missing-data
  // day (e.g. daily-price coverage ended), not a real liquidation, and would
  // otherwise drive the final period return to -1 and collapse TWR to -100%.
  let end = points.length;
  while (end > 0 && points[end - 1].marketValueCad === 0) end -= 1;
  const series = end === points.length ? points : points.slice(0, end);

  if (series.length < 2) return 0;
  if (series[0].marketValueCad === 0) return 0;

  let product = 1;
  let mvStart = series[0].marketValueCad;
  let pendingFlow = 0;
  for (let i = 1; i < series.length; i++) {
    const mvEnd = series[i].marketValueCad;
    pendingFlow += series[i].cashFlowCad;
    // An interior zero is a missing-data day (price coverage gap), not a real
    // liquidation — bridge it: defer the period until MV resumes so the gap
    // doesn't multiply a -100% into the chain.
    if (mvEnd === 0) continue;
    const r = (mvEnd - pendingFlow) / mvStart - 1;
    product *= 1 + r;
    mvStart = mvEnd;
    pendingFlow = 0;
  }
  return (product - 1) * 100;
}

export interface IrrCashFlow {
  date: string;
  amount: number;
}

const DAYS_PER_YEAR = 365.25;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function yearsBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return (b - a) / MS_PER_DAY / DAYS_PER_YEAR;
}

function npv(rate: number, cashFlows: IrrCashFlow[], anchor: string): number {
  let total = 0;
  for (const cf of cashFlows) {
    const t = yearsBetween(anchor, cf.date);
    total += cf.amount / Math.pow(1 + rate, t);
  }
  return total;
}

function npvDerivative(rate: number, cashFlows: IrrCashFlow[], anchor: string): number {
  let total = 0;
  for (const cf of cashFlows) {
    const t = yearsBetween(anchor, cf.date);
    total += -t * cf.amount / Math.pow(1 + rate, t + 1);
  }
  return total;
}

export interface AggregatedDailySnapshot {
  date: string;
  marketValueCad: number;
  cashFlowCad: number;
}

export function buildCashFlowSeries(
  snapshots: AggregatedDailySnapshot[],
  finalMvCad: number,
): IrrCashFlow[] {
  if (snapshots.length === 0) return [];
  const out: IrrCashFlow[] = [];
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));

  out.push({ date: sorted[0].date, amount: -sorted[0].marketValueCad });

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].cashFlowCad !== 0) {
      out.push({ date: sorted[i].date, amount: -sorted[i].cashFlowCad });
    }
  }

  out.push({ date: sorted[sorted.length - 1].date, amount: finalMvCad });
  return out;
}

export function computeXirr(cashFlows: IrrCashFlow[], guess = 0.1): number | null {
  if (cashFlows.length < 2) return null;
  const hasNegative = cashFlows.some((cf) => cf.amount < 0);
  const hasPositive = cashFlows.some((cf) => cf.amount > 0);
  if (!hasNegative || !hasPositive) return null;

  const sorted = [...cashFlows].sort((a, b) => a.date.localeCompare(b.date));
  const anchor = sorted[0].date;

  let rate = guess;
  for (let i = 0; i < 50; i++) {
    const f = npv(rate, sorted, anchor);
    const fPrime = npvDerivative(rate, sorted, anchor);
    if (Math.abs(fPrime) < 1e-12) return null;
    const next = rate - f / fPrime;
    if (Math.abs(next - rate) < 1e-7) return next * 100;
    rate = next;
    if (rate <= -1) rate = -0.999;
  }
  return null;
}

/**
 * Resolve the FX rate for `date` from a sparse date→rate map, preferring the
 * nearest rate on/before `date` (carry-forward) and falling back to the
 * nearest rate after it. Returns null only when the map is empty. Used to seed
 * the benchmark series' first date when it lands on a weekend/holiday with no
 * own FxRate row — defaulting that anchor to parity (1.0) would mis-scale the
 * whole series for a non-CAD benchmark.
 */
function nearestFx(fxByDate: Map<string, number>, date: string): number | null {
  const direct = fxByDate.get(date);
  if (direct != null) return direct;
  let bestBefore: { d: string; rate: number } | null = null;
  let bestAfter: { d: string; rate: number } | null = null;
  for (const [d, rate] of fxByDate) {
    if (d <= date) {
      if (!bestBefore || d > bestBefore.d) bestBefore = { d, rate };
    } else if (!bestAfter || d < bestAfter.d) {
      bestAfter = { d, rate };
    }
  }
  if (bestBefore) return bestBefore.rate;
  if (bestAfter) return bestAfter.rate;
  return null;
}

export function computeBenchmarkSeries(
  benchmarkDailyPrices: Array<{ date: string; adjClose: number }>,
  fxByDate: Map<string, number>,
  initialPortfolioValueCad: number,
): Array<{ date: string; valueCad: number }> {
  if (benchmarkDailyPrices.length === 0) return [];
  const sorted = [...benchmarkDailyPrices].sort((a, b) => a.date.localeCompare(b.date));

  // Seed from the nearest real rate, not parity: an empty map (CAD benchmark)
  // is the only case that legitimately falls back to 1.0.
  let lastFx = nearestFx(fxByDate, sorted[0].date) ?? 1;
  const firstPriceCad = sorted[0].adjClose * lastFx;
  if (firstPriceCad === 0) {
    return sorted.map((p) => ({ date: p.date, valueCad: 0 }));
  }
  const fixedShares = initialPortfolioValueCad / firstPriceCad;

  return sorted.map((p) => {
    const fx = fxByDate.get(p.date) ?? lastFx;
    lastFx = fx;
    return { date: p.date, valueCad: fixedShares * p.adjClose * fx };
  });
}
