// backend/src/summary/periodRanges.ts
export type PeriodRangeKind =
  | 'calendar-month'
  | 'calendar-quarter'
  | 'calendar-year'
  | 'custom';

export type DateRange = { from: string; to: string };

function parts(d: string): { y: number; m: number; day: number } {
  const [y, m, day] = d.split('-').map(Number);
  return { y, m, day };
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function fmt(y: number, m: number, day: number): string {
  return `${y}-${pad(m)}-${pad(day)}`;
}
function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based; day 0 of next month
}

export function detectRangeKind(from: string, to: string): PeriodRangeKind {
  const a = parts(from);
  const b = parts(to);
  // calendar year
  if (a.m === 1 && a.day === 1 && b.m === 12 && b.day === 31 && a.y === b.y) {
    return 'calendar-year';
  }
  // calendar quarter (same year, quarter-aligned start, quarter-end)
  const qStart = [1, 4, 7, 10];
  if (a.y === b.y && qStart.includes(a.m) && a.day === 1) {
    const endMonth = a.m + 2;
    if (b.m === endMonth && b.day === lastDay(b.y, b.m)) return 'calendar-quarter';
  }
  // calendar month
  if (a.y === b.y && a.m === b.m && a.day === 1 && b.day === lastDay(b.y, b.m)) {
    return 'calendar-month';
  }
  return 'custom';
}
