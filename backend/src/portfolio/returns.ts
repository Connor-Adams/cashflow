export interface DailyPoint {
  date: string;
  marketValueCad: number;
  cashFlowCad: number;
}

export function computeTwr(points: DailyPoint[]): number {
  if (points.length < 2) return 0;
  if (points[0].marketValueCad === 0) return 0;

  let product = 1;
  for (let i = 1; i < points.length; i++) {
    const mvStart = points[i - 1].marketValueCad;
    const mvEnd = points[i].marketValueCad;
    const cashFlow = points[i].cashFlowCad;
    if (mvStart === 0) continue;
    const r = (mvEnd - cashFlow) / mvStart - 1;
    product *= 1 + r;
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
