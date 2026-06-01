/**
 * Recurrence expansion for the cashflow forecast (#198).
 *
 * Input is one PlannedEvent-like row (id + expectedDate + recurrenceRule +
 * status) plus a [dateFrom, dateTo] window. Output is the dated list of
 * occurrences inside the window. The function is pure — no DB, no clock —
 * so it can be unit-tested in isolation.
 *
 * We don't depend on an RRULE library: the codebase doesn't ship one, and
 * the rule grammar we actually need to support for v1 forecast is small:
 *   FREQ=DAILY | WEEKLY | MONTHLY | YEARLY
 *   INTERVAL=N  (default 1)
 *   BYMONTHDAY=N (MONTHLY only; ignored otherwise)
 *   COUNT=N (cap total occurrences)
 *   UNTIL=YYYYMMDD (cap last date inclusive)
 *
 * Out-of-scope for v1 (intentionally — keeps the PR scope tight):
 *   - BYDAY (specific weekdays)
 *   - BYMONTH
 *   - BYSETPOS
 *   - timezones (DATEONLY in UTC throughout)
 *   - EXDATE
 *
 * If a rule fails to parse, the expander degrades gracefully: emits the
 * single seed expectedDate (if in window) rather than dropping the row.
 * That matches Connor's "better partial than blank" UX preference for
 * other forecast-ish endpoints (see netWorth gaps).
 */

import { PLANNED_EVENT_STATUSES } from '../models/PlannedEvent';

export type PlannedEventLike = {
  id: number;
  expectedDate: string;
  recurrenceRule: string | null;
  status: (typeof PLANNED_EVENT_STATUSES)[number];
};

export type Occurrence = {
  date: string;
  sourceEventId: number;
};

type ParsedRRule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byMonthDay: number | null;
  count: number | null;
  until: string | null;
};

const MAX_OCCURRENCES = 2000; // hard ceiling so a malformed rule cannot blow up the server

/**
 * Subscription-kind expectations carry a `cadence` string instead of a
 * recurrenceRule. Translate it into a rule the expander understands so a
 * subscription projects forward over the window like any other recurring
 * planned event. Returns null for an unknown/empty cadence (caller falls
 * back to one-off seed behaviour).
 */
export function cadenceToRecurrenceRule(cadence: string | null): string | null {
  switch (cadence) {
    case 'weekly':
      return 'FREQ=WEEKLY';
    case 'monthly':
      return 'FREQ=MONTHLY';
    case 'quarterly':
      return 'FREQ=MONTHLY;INTERVAL=3';
    case 'semiannual':
      return 'FREQ=MONTHLY;INTERVAL=6';
    case 'annual':
      return 'FREQ=YEARLY';
    default:
      return null;
  }
}

function parseRRule(rule: string): ParsedRRule | null {
  // Accept either a bare rule body or one prefixed with `RRULE:` (iCal style).
  let body = rule.trim();
  if (body.toUpperCase().startsWith('RRULE:')) body = body.slice(6);
  const parts = body.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const map = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) return null;
    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1).trim();
    if (!key || !val) return null;
    map.set(key, val);
  }

  const freqRaw = map.get('FREQ');
  if (!freqRaw) return null;
  const freq = freqRaw.toUpperCase() as ParsedRRule['freq'];
  if (
    freq !== 'DAILY' &&
    freq !== 'WEEKLY' &&
    freq !== 'MONTHLY' &&
    freq !== 'YEARLY'
  ) {
    return null;
  }

  const intervalRaw = map.get('INTERVAL');
  let interval = 1;
  if (intervalRaw !== undefined) {
    const n = parseInt(intervalRaw, 10);
    if (!Number.isInteger(n) || n < 1) return null;
    interval = n;
  }

  let byMonthDay: number | null = null;
  const bmdRaw = map.get('BYMONTHDAY');
  if (bmdRaw !== undefined) {
    const n = parseInt(bmdRaw, 10);
    if (!Number.isInteger(n) || n < 1 || n > 31) return null;
    byMonthDay = n;
  }

  let count: number | null = null;
  const countRaw = map.get('COUNT');
  if (countRaw !== undefined) {
    const n = parseInt(countRaw, 10);
    if (!Number.isInteger(n) || n < 1) return null;
    count = n;
  }

  let until: string | null = null;
  const untilRaw = map.get('UNTIL');
  if (untilRaw !== undefined) {
    // Accept YYYYMMDD or YYYYMMDD'T'HHMMSSZ (we drop the time part).
    const m = untilRaw.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    until = `${m[1]}-${m[2]}-${m[3]}`;
  }

  return { freq, interval, byMonthDay, count, until };
}

function isValidDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Compose a YYYY-MM-DD from y/m/d using UTC components. */
function toIso(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthOneBased: number): number {
  // Day 0 of next month = last day of current month.
  return new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + n * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function addMonths(iso: string, n: number, byMonthDay: number | null): string {
  const [y, m] = iso.split('-').map((p) => parseInt(p, 10));
  const totalMonths = (y * 12 + (m - 1) + n);
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  const targetDay = byMonthDay ?? parseInt(iso.split('-')[2], 10);
  const clamped = Math.min(targetDay, daysInMonth(ny, nm));
  return toIso(ny, nm, clamped);
}

function addYears(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  // Feb 29 → Feb 28 in non-leap years (keep month/day, clamp day to month).
  const ny = y + n;
  const clamped = Math.min(d, daysInMonth(ny, m));
  return toIso(ny, m, clamped);
}

export function expandRecurrence(
  event: PlannedEventLike,
  dateFrom: string,
  dateTo: string,
): Occurrence[] {
  // Only project rows that haven't been realised or dismissed. The four
  // states come from PlannedEventStatus; planned is the only forecast-able one.
  if (event.status !== 'planned') return [];
  if (!isValidDateString(dateFrom) || !isValidDateString(dateTo)) return [];
  if (dateTo < dateFrom) return [];

  const seedDate = event.expectedDate;
  if (!isValidDateString(seedDate)) return [];

  // Path 1: one-off event.
  if (event.recurrenceRule == null || event.recurrenceRule.trim() === '') {
    if (seedDate >= dateFrom && seedDate <= dateTo) {
      return [{ date: seedDate, sourceEventId: event.id }];
    }
    return [];
  }

  // Path 2: parse the rule. Bad rule → fall back to a single occurrence.
  const rule = parseRRule(event.recurrenceRule);
  if (!rule) {
    if (seedDate >= dateFrom && seedDate <= dateTo) {
      return [{ date: seedDate, sourceEventId: event.id }];
    }
    return [];
  }

  const occurrences: Occurrence[] = [];
  let current = seedDate;
  let step = 0;

  // Generate occurrences in order. Stop when:
  //   - we exceed COUNT
  //   - we go past UNTIL
  //   - we go past dateTo
  //   - we hit MAX_OCCURRENCES (defensive cap)
  while (step < MAX_OCCURRENCES) {
    if (rule.until && current > rule.until) break;
    if (current > dateTo) break;

    if (current >= dateFrom) {
      occurrences.push({ date: current, sourceEventId: event.id });
    }

    // COUNT is total occurrences (including any before dateFrom).
    if (rule.count !== null && step + 1 >= rule.count) break;

    // Advance.
    let next: string;
    switch (rule.freq) {
      case 'DAILY':
        next = addDays(current, rule.interval);
        break;
      case 'WEEKLY':
        next = addDays(current, 7 * rule.interval);
        break;
      case 'MONTHLY':
        next = addMonths(current, rule.interval, rule.byMonthDay);
        break;
      case 'YEARLY':
        next = addYears(current, rule.interval);
        break;
    }
    // Guard against an INTERVAL=0 or similar parse miss that would loop
    // forever on the same date.
    if (next <= current) break;
    current = next;
    step += 1;
  }

  return occurrences;
}
