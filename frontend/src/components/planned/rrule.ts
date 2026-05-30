export type Frequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface ParsedRRule {
  freq: Frequency;
  // Weekly
  byDay?: Weekday[];
  // Monthly
  byMonthDay?: number;
  // Monthly by weekday position: {ordinal: 1|-1|2|3|4, day: Weekday}
  byWeekdayPos?: { ordinal: number; day: Weekday };
  // Yearly
  byMonth?: number;
  yearlyDay?: number;
  // Raw string if unparseable by picker
  raw?: string;
}

const WEEKDAY_MAP: Record<string, Weekday> = {
  MO: 'MO', TU: 'TU', WE: 'WE', TH: 'TH', FR: 'FR', SA: 'SA', SU: 'SU'
};

export function parseRRule(rule: string): ParsedRRule {
  if (!rule || rule.trim() === '') return { freq: 'none' };
  const str = rule.replace(/^RRULE:/i, '').trim();
  const parts: Record<string, string> = {};
  for (const part of str.split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) parts[k.toUpperCase()] = v;
  }
  const freq = parts['FREQ']?.toLowerCase();
  if (freq === 'daily') return { freq: 'daily' };
  if (freq === 'weekly') {
    const days = (parts['BYDAY'] ?? '').split(',').filter(d => d in WEEKDAY_MAP) as Weekday[];
    return { freq: 'weekly', byDay: days };
  }
  if (freq === 'monthly') {
    const byMonthDay = parts['BYMONTHDAY'] ? parseInt(parts['BYMONTHDAY']) : undefined;
    if (byMonthDay) return { freq: 'monthly', byMonthDay };
    const byDay = parts['BYDAY'];
    if (byDay) {
      // e.g. "2MO" or "-1FR"
      const m = byDay.match(/^(-?\d)([A-Z]{2})$/);
      if (m) {
        const ordinal = parseInt(m[1]);
        const day = m[2] as Weekday;
        if (day in WEEKDAY_MAP) return { freq: 'monthly', byWeekdayPos: { ordinal, day } };
      }
    }
    return { freq: 'monthly', raw: rule };
  }
  if (freq === 'yearly') {
    const byMonth = parts['BYMONTH'] ? parseInt(parts['BYMONTH']) : undefined;
    const byMonthDay = parts['BYMONTHDAY'] ? parseInt(parts['BYMONTHDAY']) : undefined;
    if (byMonth && byMonthDay) return { freq: 'yearly', byMonth, yearlyDay: byMonthDay };
    return { freq: 'yearly', raw: rule };
  }
  return { freq: 'none', raw: rule };
}

export function serializeRRule(parsed: ParsedRRule): string {
  if (parsed.freq === 'none') return '';
  if (parsed.freq === 'daily') return 'RRULE:FREQ=DAILY';
  if (parsed.freq === 'weekly') {
    const days = parsed.byDay?.join(',') ?? '';
    return `RRULE:FREQ=WEEKLY;BYDAY=${days}`;
  }
  if (parsed.freq === 'monthly') {
    if (parsed.byMonthDay) return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${parsed.byMonthDay}`;
    if (parsed.byWeekdayPos) {
      const { ordinal, day } = parsed.byWeekdayPos;
      return `RRULE:FREQ=MONTHLY;BYDAY=${ordinal}${day}`;
    }
  }
  if (parsed.freq === 'yearly' && parsed.byMonth && parsed.yearlyDay) {
    return `RRULE:FREQ=YEARLY;BYMONTH=${parsed.byMonth};BYMONTHDAY=${parsed.yearlyDay}`;
  }
  return parsed.raw ?? '';
}

const WEEKDAY_LABELS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WEEKDAY_DISPLAY: Record<Weekday, string> = {
  MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S', SU: 'S'
};
const WEEKDAY_ARIA: Record<Weekday, string> = {
  MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday',
  FR: 'Friday', SA: 'Saturday', SU: 'Sunday'
};

export { WEEKDAY_LABELS, WEEKDAY_DISPLAY, WEEKDAY_ARIA };

// Compute next N occurrences from a start date and parsed RRULE
export function nextOccurrences(parsed: ParsedRRule, startDate: string, n: number): string[] {
  if (parsed.freq === 'none' || !startDate) return [];
  const start = new Date(`${startDate}T00:00:00`);
  if (isNaN(start.getTime())) return [];

  const results: string[] = [];
  let cursor = new Date(start);
  let iterations = 0;
  const maxIter = 400;

  while (results.length < n && iterations < maxIter) {
    iterations++;
    const next = nextAfter(parsed, cursor, results.length === 0 ? start : cursor);
    if (!next) break;
    results.push(next.toISOString().slice(0, 10));
    cursor = new Date(next.getTime() + 86400000); // move 1 day past to avoid duplicates
  }
  return results;
}

function nextAfter(parsed: ParsedRRule, from: Date, _start: Date): Date | null {
  // Simple: find the next date >= from that matches the recurrence
  const MAX_DAYS = 400;
  const cur = new Date(from);
  for (let i = 0; i < MAX_DAYS; i++) {
    if (matches(parsed, cur)) return new Date(cur);
    cur.setDate(cur.getDate() + 1);
  }
  return null;
}

function matches(parsed: ParsedRRule, d: Date): boolean {
  if (parsed.freq === 'daily') return true;
  if (parsed.freq === 'weekly') {
    const dayNames: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const weekday = dayNames[d.getDay()];
    return parsed.byDay?.includes(weekday) ?? false;
  }
  if (parsed.freq === 'monthly') {
    if (parsed.byMonthDay) return d.getDate() === parsed.byMonthDay;
    if (parsed.byWeekdayPos) {
      const { ordinal, day } = parsed.byWeekdayPos;
      const dayNames: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
      if (dayNames[d.getDay()] !== day) return false;
      if (ordinal === -1) {
        // Last weekday in month
        const next = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        while (dayNames[next.getDay()] !== day) next.setDate(next.getDate() - 1);
        return next.getDate() === d.getDate();
      }
      // Nth occurrence: count weekdays of that type in the month so far
      let count = 0;
      const temp = new Date(d.getFullYear(), d.getMonth(), 1);
      while (temp <= d) {
        if (dayNames[temp.getDay()] === day) count++;
        temp.setDate(temp.getDate() + 1);
      }
      return count === ordinal;
    }
  }
  if (parsed.freq === 'yearly') {
    if (parsed.byMonth && parsed.yearlyDay) {
      return d.getMonth() + 1 === parsed.byMonth && d.getDate() === parsed.yearlyDay;
    }
  }
  return false;
}
