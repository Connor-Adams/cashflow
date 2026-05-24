/**
 * Shared date-parsing helpers used by multiple PDF parsers (CIBC, RBC).
 *
 * The RBC and CIBC statement layouts both use `Mon DD` (3-letter month +
 * day, no year) for transaction-row dates. The year is inferred from the
 * statement period bracketing the row.
 */

export const MONTHS_SHORT: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

export type Period = { start: string; end: string };

export function toIso(year: number, monthZeroBased: number, day: number): string {
  const m = String(monthZeroBased + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/** Parse "January 12, 2026" → ISO. Returns null on failure. */
export function parseLongDate(s: string): string | null {
  const m = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (!m) return null;
  const monthName = m[1].slice(0, 3);
  const month = MONTHS_SHORT[monthName];
  if (month === undefined) return null;
  return toIso(Number(m[3]), month, Number(m[2]));
}

/**
 * Parse a "<Mon DD[, YYYY]> to <Mon DD, YYYY>" period.
 * Both forms occur in real statements:
 *   "November 13 to December 12, 2025"          (same year, abbreviated start)
 *   "December 13, 2025 to January 12, 2026"     (year boundary, fully qualified start)
 */
export function parsePeriod(s: string): Period | null {
  const both = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+to\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (both) {
    const startMonth = MONTHS_SHORT[both[1].slice(0, 3)];
    const endMonth = MONTHS_SHORT[both[4].slice(0, 3)];
    if (startMonth === undefined || endMonth === undefined) return null;
    return {
      start: toIso(Number(both[3]), startMonth, Number(both[2])),
      end: toIso(Number(both[6]), endMonth, Number(both[5])),
    };
  }
  const abbrev = /([A-Z][a-z]+)\s+(\d{1,2})\s+to\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (abbrev) {
    const startMonth = MONTHS_SHORT[abbrev[1].slice(0, 3)];
    const endMonth = MONTHS_SHORT[abbrev[3].slice(0, 3)];
    if (startMonth === undefined || endMonth === undefined) return null;
    const year = Number(abbrev[5]);
    const start = toIso(year, startMonth, Number(abbrev[2]));
    const end = toIso(year, endMonth, Number(abbrev[4]));
    return {
      start: start > end ? toIso(year - 1, startMonth, Number(abbrev[2])) : start,
      end,
    };
  }
  return null;
}

/**
 * Date columns in many statements are "Mon DD" with no year. Pick the year
 * (period-start or period-end) whose calendar makes the date land inside the
 * statement window with a small slack (trans date can precede period start
 * by a few days; post date sits inside).
 */
export function inferYearForMonthDay(monthDay: string, period: Period): number {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(monthDay);
  if (!m) throw new Error(`Unparseable month-day: ${JSON.stringify(monthDay)}`);
  const month = MONTHS_SHORT[m[1]];
  if (month === undefined) throw new Error(`Unknown month abbreviation: ${m[1]}`);
  const day = Number(m[2]);

  const startMs = Date.parse(period.start + 'T00:00:00Z');
  const endMs = Date.parse(period.end + 'T00:00:00Z');
  const slackMs = 5 * 24 * 60 * 60 * 1000;
  const startYear = new Date(startMs).getUTCFullYear();
  const endYear = new Date(endMs).getUTCFullYear();

  const candidates = startYear === endYear ? [startYear] : [startYear, endYear];
  for (const year of candidates) {
    const ms = Date.UTC(year, month, day);
    if (ms >= startMs - slackMs && ms <= endMs + slackMs) return year;
  }
  throw new Error(
    `Month-day ${monthDay} does not fit statement period ${period.start}…${period.end}`,
  );
}

/** Convert "Mon DD" (with year inferred from period) to ISO. */
export function monthDayToIso(monthDay: string, period: Period): string {
  const year = inferYearForMonthDay(monthDay, period);
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(monthDay);
  if (!m) throw new Error(`Unparseable month-day: ${monthDay}`);
  const month = MONTHS_SHORT[m[1]];
  if (month === undefined) throw new Error(`Unknown month abbreviation: ${m[1]}`);
  return toIso(year, month, Number(m[2]));
}

/**
 * RBC personal-banking date columns are `D Mon` (day-first, abbreviated
 * month, no year): "4 Nov", "13 Nov", "1 Dec". Convert to ISO using the
 * statement period to disambiguate the year.
 */
export function dayMonthToIso(dayMonth: string, period: Period): string {
  const m = /^(\d{1,2})\s+([A-Z][a-z]{2})$/.exec(dayMonth.trim());
  if (!m) throw new Error(`Unparseable day-month: ${JSON.stringify(dayMonth)}`);
  const day = Number(m[1]);
  const monKey = m[2];
  const month = MONTHS_SHORT[monKey];
  if (month === undefined) throw new Error(`Unknown month abbreviation: ${monKey}`);
  // Reuse year-inference: build a "Mon DD" string that inferYearForMonthDay accepts.
  const year = inferYearForMonthDay(`${monKey} ${day}`, period);
  return toIso(year, month, day);
}

/** Parse a number string like "$1,234.56" or "(123.45)" or "12.34CR" or "-12.34". */
export function parseMoney(raw: string): number {
  const trimmed = raw.replace(/[\s$]/g, '');
  if (!trimmed) return NaN;
  // Parenthesized = negative ((123.45))
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const inner = trimmed.slice(1, -1).replace(/,/g, '');
    const n = Number(inner);
    return Number.isFinite(n) ? -n : NaN;
  }
  // CR suffix = credit (treat as negative magnitude per common bank convention)
  const crMatch = /^(-?[\d,]+\.?\d*)\s*CR$/i.exec(trimmed);
  if (crMatch) {
    const n = Number(crMatch[1].replace(/,/g, ''));
    return Number.isFinite(n) ? -Math.abs(n) : NaN;
  }
  return Number(trimmed.replace(/,/g, ''));
}
