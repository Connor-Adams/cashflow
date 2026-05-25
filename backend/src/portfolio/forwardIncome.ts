export type CadenceLabel =
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'irregular'
  | 'none';

export interface PaymentEvent {
  date: Date;
  perShareAmount: number;
}

export interface CadenceResult {
  annualPerShare: number;
  medianSpacingDays: number | null;
  cadenceLabel: CadenceLabel;
  cvPct: number | null;
  eventCount12mo: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function labelFromCount(n: number): CadenceLabel {
  if (n === 0) return 'none';
  if (n === 1) return 'annual';
  if (n === 2) return 'semiannual';
  if (n >= 3 && n <= 5) return 'quarterly';
  if (n >= 10 && n <= 15) return 'monthly';
  return 'irregular';
}

export function inferCadence(events: PaymentEvent[], asOf: Date): CadenceResult {
  const cutoff = new Date(asOf.getTime() - 365 * ONE_DAY_MS);
  const inWindow = events
    .filter((e) => e.date >= cutoff && e.date <= asOf)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const annualPerShare = inWindow.reduce((s, e) => s + e.perShareAmount, 0);

  let medianSpacingDays: number | null = null;
  if (inWindow.length >= 2) {
    const spacings: number[] = [];
    for (let i = 1; i < inWindow.length; i++) {
      const diff = (inWindow[i].date.getTime() - inWindow[i - 1].date.getTime()) / ONE_DAY_MS;
      spacings.push(diff);
    }
    spacings.sort((a, b) => a - b);
    medianSpacingDays = Math.round(median(spacings));
  }

  let cvPct: number | null = null;
  if (inWindow.length >= 4) {
    const last4 = inWindow.slice(-4).map((e) => e.perShareAmount);
    const mean = last4.reduce((s, x) => s + x, 0) / 4;
    if (mean !== 0) {
      const variance = last4.reduce((s, x) => s + (x - mean) ** 2, 0) / 4;
      // Percentage (0-100+) consistent with repo *Pct convention (e.g. todayChangePct)
      cvPct = (Math.sqrt(variance) / Math.abs(mean)) * 100;
    } else {
      cvPct = 0;
    }
  }

  return {
    annualPerShare,
    medianSpacingDays,
    cadenceLabel: labelFromCount(inWindow.length),
    cvPct,
    eventCount12mo: inWindow.length,
  };
}

export interface ProjectNextEventsArgs {
  lastEventDate: Date;
  medianSpacingDays: number;
  lastPerShareAmount: number;
  horizonDays: number;
  asOf: Date;
}

export function projectNextEvents(args: ProjectNextEventsArgs): Array<{
  date: Date;
  estimatedPerShare: number;
}> {
  const { lastEventDate, medianSpacingDays, lastPerShareAmount, horizonDays, asOf } = args;
  if (medianSpacingDays <= 0) return [];
  const horizonEnd = new Date(asOf.getTime() + horizonDays * ONE_DAY_MS);
  const out: Array<{ date: Date; estimatedPerShare: number }> = [];
  let next = new Date(lastEventDate.getTime() + medianSpacingDays * ONE_DAY_MS);
  while (next <= horizonEnd) {
    if (next > asOf) {
      out.push({ date: next, estimatedPerShare: lastPerShareAmount });
    }
    next = new Date(next.getTime() + medianSpacingDays * ONE_DAY_MS);
  }
  return out;
}
