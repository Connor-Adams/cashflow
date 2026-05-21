import type { Signal } from './types';

export interface RecurringHistoryRow {
  date: string;
  amount: number;
  finalCategory: string | null;
}

export interface DetectRecurringInput {
  merchantClean: string;
  amount: number;
  date: string;
  history: RecurringHistoryRow[];
  minSupport: number;
}

const MONTHLY_DAYS = 30;
const CADENCE_TOLERANCE_DAYS = 5;
const AMOUNT_TOLERANCE_RATIO = 0.05;

function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((ta - tb) / 86400000);
}

function amountWithinRatio(target: number, candidate: number, ratio: number): boolean {
  const base = Math.abs(target);
  if (base === 0) return Math.abs(candidate) === 0;
  return Math.abs(Math.abs(candidate) - base) / base <= ratio;
}

function modalNonNull(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v == null || v.trim() === '') continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, n] of counts) {
    if (n > bestCount) {
      best = k;
      bestCount = n;
    }
  }
  return best;
}

export function runDetectRecurringStage(input: DetectRecurringInput): Signal[] {
  const matching = input.history
    .filter((r) => amountWithinRatio(input.amount, r.amount, AMOUNT_TOLERANCE_RATIO))
    .map((r) => ({ ...r, daysAgo: daysBetween(input.date, r.date) }))
    .filter((r) => r.daysAgo > 0)
    .sort((a, b) => a.daysAgo - b.daysAgo);

  if (matching.length < input.minSupport) return [];

  const cadenceOk = matching.slice(0, input.minSupport).every((r, idx) => {
    const expected = (idx + 1) * MONTHLY_DAYS;
    return Math.abs(r.daysAgo - expected) <= CADENCE_TOLERANCE_DAYS;
  });
  if (!cadenceOk) return [];

  const modalCategory = modalNonNull(matching.slice(0, input.minSupport).map((r) => r.finalCategory));

  return [
    {
      source: 'recurring',
      confidence: 'high',
      fields: {
        isRecurring: true,
        autoCategory: modalCategory,
      },
      rationale: `${matching.length} prior monthly-cadence transactions at this merchant + amount`,
    },
  ];
}
