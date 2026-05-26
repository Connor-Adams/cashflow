/**
 * In-house RRULE expander for the calendar route. Supports the subset of
 * RFC 5545 most commonly used in personal-finance recurring events:
 *
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY
 *   INTERVAL=N (default 1)
 *   COUNT=N (max occurrences from anchor)
 *   UNTIL=YYYYMMDD or YYYYMMDDTHHMMSSZ (UTC)
 *   BYMONTHDAY=N (1..31, positive only)
 *   BYDAY=MO,TU,WE,TH,FR,SA,SU (weekly only; comma-separated)
 *
 * Anything outside this surface (BYSETPOS, BYWEEKNO, EXDATE, etc.) is
 * ignored — the caller gets the anchor-only fallback for malformed or
 * unsupported rules.
 *
 * Why hand-rolled? The repo intentionally avoids the `rrule` package to
 * keep bundle and audit surface small. This module is a few dozen lines,
 * covers ~95% of what users actually write, and the forecast worker
 * (#198) maintains its own expansion logic — both intentionally siloed
 * because their PRs ship independently.
 *
 * Date math is anchored at UTC noon to avoid DST off-by-one bugs when
 * Date arithmetic crosses a daylight boundary. The output is always
 * ISO date strings (YYYY-MM-DD) so the caller doesn't have to think
 * about timezones.
 */

/**
 * Hard cap to prevent runaway expansions (e.g. FREQ=DAILY over 100 years).
 * Personal finance never legitimately needs more than a few hundred
 * occurrences in a single calendar query window.
 */
const MAX_OCCURRENCES = 1000;

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

type RruleParts = {
  freq: Frequency | null;
  interval: number;
  count: number | null;
  until: string | null;
  byMonthDay: number | null;
  byDay: Set<number> | null;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(s: string): Date | null {
  if (!ISO_DATE_RE.test(s)) return null;
  // Anchor at UTC noon — clears DST boundaries when adding days.
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(d: Date, months: number, anchorDay: number): Date {
  // Honour the original day-of-month, clamped to month length so adding a
  // month to Jan 31 lands on Feb 28/29, not March 3.
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  const next = new Date(Date.UTC(year, month, 1, 12, 0, 0));
  const lastDayOfMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(anchorDay, lastDayOfMonth));
  return next;
}

function addYears(d: Date, years: number): Date {
  const next = new Date(d);
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

/**
 * Parse a UNTIL parameter. Accepts YYYYMMDD or YYYYMMDDTHHMMSSZ; returns
 * the date portion as an ISO date string (the time is intentionally
 * dropped — calendar slots are day-granular).
 */
function parseUntil(raw: string): string | null {
  const datePart = raw.slice(0, 8);
  if (!/^\d{8}$/.test(datePart)) return null;
  const y = datePart.slice(0, 4);
  const m = datePart.slice(4, 6);
  const d = datePart.slice(6, 8);
  const candidate = `${y}-${m}-${d}`;
  return parseIsoDate(candidate) ? candidate : null;
}

function parseByDay(raw: string): Set<number> | null {
  const items = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (items.length === 0) return null;
  const out = new Set<number>();
  for (const code of items) {
    const idx = (DAY_CODES as readonly string[]).indexOf(code);
    if (idx < 0) return null;
    out.add(idx);
  }
  return out;
}

function parseRule(rule: string): RruleParts {
  const parts: RruleParts = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byMonthDay: null,
    byDay: null,
  };

  // Allow leading "RRULE:" prefix; otherwise just parse the K=V;... body.
  const body = rule.replace(/^\s*RRULE:/i, '').trim();
  if (!body) return parts;

  for (const segment of body.split(';')) {
    const [keyRaw, valueRaw] = segment.split('=');
    if (!keyRaw || valueRaw == null) continue;
    const key = keyRaw.trim().toUpperCase();
    const value = valueRaw.trim();
    switch (key) {
      case 'FREQ':
        if (value === 'DAILY' || value === 'WEEKLY' || value === 'MONTHLY' || value === 'YEARLY') {
          parts.freq = value;
        }
        break;
      case 'INTERVAL': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n > 0) parts.interval = n;
        break;
      }
      case 'COUNT': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n > 0) parts.count = n;
        break;
      }
      case 'UNTIL': {
        const until = parseUntil(value);
        if (until) parts.until = until;
        break;
      }
      case 'BYMONTHDAY': {
        const n = parseInt(value, 10);
        if (Number.isInteger(n) && n >= 1 && n <= 31) parts.byMonthDay = n;
        break;
      }
      case 'BYDAY':
        parts.byDay = parseByDay(value);
        break;
    }
  }
  return parts;
}

/**
 * Expand an RRULE (or null/empty for one-off) anchored at `anchorDate`
 * into the set of YYYY-MM-DD occurrences that fall inside
 * [windowStart, windowEnd] inclusive.
 *
 * Returns a sorted array of ISO date strings. Always safe to call:
 * - null/empty/whitespace rule → [anchorDate] when in window, else []
 * - malformed rule → same fallback
 * - any FREQ recognised but with no occurrences in window → []
 * - runaway rule (DAILY * 100y) → capped at MAX_OCCURRENCES to be safe
 */
export function expandRecurrence(
  rule: string | null | undefined,
  anchorDate: string,
  windowStart: string,
  windowEnd: string,
): string[] {
  if (windowStart > windowEnd) return [];

  const anchor = parseIsoDate(anchorDate);
  if (!anchor) return [];

  const inWindow = (iso: string) => iso >= windowStart && iso <= windowEnd;

  if (rule == null || rule.trim() === '') {
    return inWindow(anchorDate) ? [anchorDate] : [];
  }

  const parts = parseRule(rule);
  if (parts.freq == null) {
    return inWindow(anchorDate) ? [anchorDate] : [];
  }

  // Materialize occurrences with two ceilings: COUNT (from the rule) and
  // MAX_OCCURRENCES (defense-in-depth against runaway windows).
  const result: string[] = [];
  const seen = new Set<string>();
  const startDay = anchor;
  const untilIso = parts.until;

  function push(d: Date) {
    const iso = toIsoDate(d);
    if (seen.has(iso)) return;
    seen.add(iso);
    if (iso > windowEnd) return;
    if (untilIso != null && iso > untilIso) return;
    if (iso >= windowStart) result.push(iso);
  }

  let countEmitted = 0;
  const countLimit = parts.count ?? Infinity;

  if (parts.freq === 'DAILY') {
    let cursor = startDay;
    while (
      toIsoDate(cursor) <= windowEnd &&
      (untilIso == null || toIsoDate(cursor) <= untilIso) &&
      countEmitted < countLimit &&
      countEmitted < MAX_OCCURRENCES
    ) {
      push(cursor);
      countEmitted += 1;
      cursor = addDays(cursor, parts.interval);
    }
  } else if (parts.freq === 'WEEKLY') {
    // If BYDAY is provided, enumerate within each "interval week" from
    // anchor; otherwise emit anchor + every N*7 days.
    if (parts.byDay && parts.byDay.size > 0) {
      // Find the Sunday-anchored week-start for the anchor week.
      const anchorDow = startDay.getUTCDay();
      let weekStart = addDays(startDay, -anchorDow);
      while (
        toIsoDate(weekStart) <= windowEnd &&
        countEmitted < countLimit &&
        countEmitted < MAX_OCCURRENCES
      ) {
        const daysInOrder = Array.from(parts.byDay).sort((a, b) => a - b);
        for (const dow of daysInOrder) {
          const candidate = addDays(weekStart, dow);
          const iso = toIsoDate(candidate);
          if (iso < toIsoDate(startDay)) continue; // never before anchor
          if (iso > windowEnd) break;
          if (untilIso != null && iso > untilIso) break;
          push(candidate);
          countEmitted += 1;
          if (countEmitted >= countLimit) break;
          if (countEmitted >= MAX_OCCURRENCES) break;
        }
        weekStart = addDays(weekStart, 7 * parts.interval);
      }
    } else {
      let cursor = startDay;
      while (
        toIsoDate(cursor) <= windowEnd &&
        (untilIso == null || toIsoDate(cursor) <= untilIso) &&
        countEmitted < countLimit &&
        countEmitted < MAX_OCCURRENCES
      ) {
        push(cursor);
        countEmitted += 1;
        cursor = addDays(cursor, 7 * parts.interval);
      }
    }
  } else if (parts.freq === 'MONTHLY') {
    // BYMONTHDAY pins to that day each month, starting the month AFTER the
    // anchor month if anchor's day != BYMONTHDAY (RFC ambiguous; we err
    // on the side of "the rule means the requested day, not the anchor
    // day"). Otherwise honour the anchor day each month.
    const anchorDay = parts.byMonthDay ?? startDay.getUTCDate();
    let stepMonth = 0;
    // If BYMONTHDAY is set but anchor day differs, skip month 0 (no
    // legal occurrence — the anchor isn't on the requested day).
    if (parts.byMonthDay != null && startDay.getUTCDate() !== parts.byMonthDay) {
      stepMonth = 1;
    }
    while (countEmitted < countLimit && countEmitted < MAX_OCCURRENCES) {
      const candidate = addMonths(startDay, stepMonth * parts.interval, anchorDay);
      const iso = toIsoDate(candidate);
      if (iso > windowEnd) break;
      if (untilIso != null && iso > untilIso) break;
      push(candidate);
      countEmitted += 1;
      stepMonth += 1;
    }
  } else if (parts.freq === 'YEARLY') {
    let stepYear = 0;
    while (countEmitted < countLimit && countEmitted < MAX_OCCURRENCES) {
      const candidate = addYears(startDay, stepYear * parts.interval);
      const iso = toIsoDate(candidate);
      if (iso > windowEnd) break;
      if (untilIso != null && iso > untilIso) break;
      push(candidate);
      countEmitted += 1;
      stepYear += 1;
    }
  }

  result.sort();
  return result;
}
