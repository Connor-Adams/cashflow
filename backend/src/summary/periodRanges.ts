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

function addDays(d: string, n: number): string {
  const p = parts(d);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.day + n));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function dayCount(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  const ms =
    Date.UTC(b.y, b.m - 1, b.day) - Date.UTC(a.y, a.m - 1, a.day);
  return Math.round(ms / 86_400_000) + 1; // inclusive
}
function monthRange(y: number, m: number): DateRange {
  return { from: fmt(y, m, 1), to: fmt(y, m, lastDay(y, m)) };
}

export function priorPeriod(
  from: string,
  to: string,
  kind: PeriodRangeKind,
): DateRange {
  const a = parts(from);
  if (kind === 'calendar-month') {
    const m = a.m === 1 ? 12 : a.m - 1;
    const y = a.m === 1 ? a.y - 1 : a.y;
    return monthRange(y, m);
  }
  if (kind === 'calendar-quarter') {
    const startM = a.m - 3;
    const y = startM < 1 ? a.y - 1 : a.y;
    const m = startM < 1 ? startM + 12 : startM;
    return { from: fmt(y, m, 1), to: fmt(y, m + 2, lastDay(y, m + 2)) };
  }
  if (kind === 'calendar-year') {
    return { from: fmt(a.y - 1, 1, 1), to: fmt(a.y - 1, 12, 31) };
  }
  // custom: prior equal-length span ending the day before `from`
  const span = dayCount(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));
  return { from: prevFrom, to: prevTo };
}

export function samePeriodLastYear(
  from: string,
  _to: string,
  kind: PeriodRangeKind,
): DateRange | null {
  if (kind === 'custom') return null;
  const a = parts(from);
  if (kind === 'calendar-month') return monthRange(a.y - 1, a.m);
  if (kind === 'calendar-quarter') {
    return { from: fmt(a.y - 1, a.m, 1), to: fmt(a.y - 1, a.m + 2, lastDay(a.y - 1, a.m + 2)) };
  }
  // calendar-year
  return { from: fmt(a.y - 1, 1, 1), to: fmt(a.y - 1, 12, 31) };
}

export type TypicalWindows = { windows: DateRange[]; minRequired: number };

export function typicalWindows(
  from: string,
  _to: string,
  kind: PeriodRangeKind,
): TypicalWindows {
  const a = parts(from);
  if (kind === 'calendar-month') {
    const windows: DateRange[] = [];
    let y = a.y;
    let m = a.m;
    for (let i = 0; i < 12; i++) {
      m = m === 1 ? 12 : m - 1;
      if (m === 12) y -= 1;
      windows.push(monthRange(y, m));
    }
    return { windows, minRequired: 3 };
  }
  if (kind === 'calendar-quarter') {
    const windows: DateRange[] = [];
    let y = a.y;
    let startM = a.m;
    for (let i = 0; i < 4; i++) {
      startM -= 3;
      if (startM < 1) {
        startM += 12;
        y -= 1;
      }
      windows.push({ from: fmt(y, startM, 1), to: fmt(y, startM + 2, lastDay(y, startM + 2)) });
    }
    return { windows, minRequired: 2 };
  }
  return { windows: [], minRequired: Infinity };
}
