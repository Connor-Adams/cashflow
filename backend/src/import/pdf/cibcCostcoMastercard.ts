import type { PdfLine, PdfParser } from './types';

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

export type CibcCostcoHeader = {
  statementDate: string;     // YYYY-MM-DD
  periodStart: string;       // YYYY-MM-DD
  periodEnd: string;         // YYYY-MM-DD
  accountLast4: string;      // e.g. "3114"
};

function toIso(year: number, monthZeroBased: number, day: number): string {
  const m = String(monthZeroBased + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/** Parse "January 12, 2026" → ISO. Returns null on failure. */
function parseLongDate(s: string): string | null {
  const m = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (!m) return null;
  const monthName = m[1].slice(0, 3) as keyof typeof MONTHS;
  const month = MONTHS[monthName];
  if (month === undefined) return null;
  return toIso(Number(m[3]), month, Number(m[2]));
}

/**
 * Parse the "<Mon DD> to <Mon DD, YYYY>" or "<Mon DD, YYYY> to <Mon DD, YYYY>" period.
 * Both forms appear in CIBC statements:
 *   "November 13 to December 12, 2025"          (same year, abbreviated start)
 *   "December 13, 2025 to January 12, 2026"     (year boundary, fully qualified start)
 */
function parsePeriod(s: string): { start: string; end: string } | null {
  const both = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+to\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (both) {
    const startMonth = MONTHS[both[1].slice(0, 3)];
    const endMonth = MONTHS[both[4].slice(0, 3)];
    if (startMonth === undefined || endMonth === undefined) return null;
    return {
      start: toIso(Number(both[3]), startMonth, Number(both[2])),
      end: toIso(Number(both[6]), endMonth, Number(both[5])),
    };
  }
  const abbrev = /([A-Z][a-z]+)\s+(\d{1,2})\s+to\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (abbrev) {
    const startMonth = MONTHS[abbrev[1].slice(0, 3)];
    const endMonth = MONTHS[abbrev[3].slice(0, 3)];
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

export function parseCibcCostcoHeader(lines: PdfLine[]): CibcCostcoHeader {
  const page1 = lines.filter((l) => l.page === 1);

  // Statement date — labelled "Statement Date" on one line, value on the next or same line.
  let statementDate: string | null = null;
  for (let i = 0; i < page1.length; i++) {
    if (/statement date/i.test(page1[i].text)) {
      const sameLine = parseLongDate(page1[i].text);
      if (sameLine) { statementDate = sameLine; break; }
      const next = page1[i + 1]?.text ?? '';
      const nextParsed = parseLongDate(next);
      if (nextParsed) { statementDate = nextParsed; break; }
    }
  }
  if (!statementDate) throw new Error('CIBC Costco header: could not parse Statement Date');

  // Period — appears as "<Month> statement period" followed by the period line.
  let period: { start: string; end: string } | null = null;
  for (let i = 0; i < page1.length; i++) {
    if (/statement period/i.test(page1[i].text)) {
      period = parsePeriod(page1[i].text) || parsePeriod(page1[i + 1]?.text ?? '');
      if (period) break;
    }
  }
  // Fallback: scan "Transactions from <DATE> to <DATE>" anywhere.
  if (!period) {
    for (const l of lines) {
      const m = /Transactions from\s+(.+)/.exec(l.text);
      if (m) {
        period = parsePeriod(m[1]);
        if (period) break;
      }
    }
  }
  if (!period) throw new Error('CIBC Costco header: could not parse statement period');

  // Account last 4 — "5160 XXXX XXXX NNNN".
  let last4: string | null = null;
  for (const l of page1) {
    const m = /5160\s+[Xx]{4}\s+[Xx]{4}\s+(\d{4})/.exec(l.text);
    if (m) { last4 = m[1]; break; }
  }
  if (!last4) throw new Error('CIBC Costco header: could not parse account last4');

  return {
    statementDate,
    periodStart: period.start,
    periodEnd: period.end,
    accountLast4: last4,
  };
}

export type Period = { start: string; end: string };

export type CibcCostcoSection = 'payments' | 'interest' | 'charges';

/**
 * Date columns in CIBC statements are "Mon DD" with no year. Pick the year
 * (period-start or period-end) whose calendar makes the date land inside the
 * statement window with a small slack (trans date can precede period start
 * by a few days; post date sits inside).
 */
export function inferYearForMonthDay(monthDay: string, period: Period): number {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(monthDay);
  if (!m) throw new Error(`Unparseable month-day: ${JSON.stringify(monthDay)}`);
  const month = MONTHS[m[1]];
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

/**
 * Parse one transaction row from the layout-reconstructed line text.
 *
 * Strategy: trans-date and post-date are at the LEFT (fixed width); amount is
 * the LAST token on the line (decimal with optional CR / leading minus); the
 * description is everything in between, minus the spend-category column for
 * `charges` rows. We tokenize by run of 2+ spaces (the column separator).
 */
export function parseCibcCostcoRow(
  rawLine: string,
  period: Period,
  section: CibcCostcoSection,
): { date: string; merchantRaw: string; amount: number } {
  const line = rawLine.replace(/^\s+|\s+$/g, '');
  const stripBonus = (s: string) => s.replace(/\s*Ý\s+/g, ' ').trim();

  const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);
  if (cols.length < 3) {
    throw new Error(`CIBC Costco row has too few columns: ${JSON.stringify(rawLine)}`);
  }

  const postDate = cols[1];
  const amountStr = cols[cols.length - 1];

  const middleEnd = section === 'payments' ? cols.length - 1 : cols.length - 2;
  const merchantRaw = stripBonus(cols.slice(2, middleEnd).join(' ')).replace(/\s+/g, ' ');

  const year = inferYearForMonthDay(postDate, period);
  const md = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(postDate);
  if (!md) throw new Error(`Unparseable post date: ${postDate}`);
  const postMonth = MONTHS[md[1]];
  if (postMonth === undefined) throw new Error(`Unknown month abbreviation: ${md[1]}`);
  const day = Number(md[2]);
  const date = toIso(year, postMonth, day);

  const cleaned = amountStr.replace(/[$,]/g, '').trim();
  let magnitude = NaN;
  let isCredit = false;
  const crMatch = /^(-?)([\d.]+)\s*CR$/i.exec(cleaned);
  if (crMatch) {
    magnitude = Number(crMatch[2]);
    isCredit = true;
  } else {
    magnitude = Number(cleaned);
    if (cleaned.startsWith('-')) isCredit = true;
  }
  if (!Number.isFinite(magnitude)) {
    throw new Error(`CIBC Costco row has unparseable amount: ${JSON.stringify(amountStr)}`);
  }

  const abs = Math.abs(magnitude);
  let amount: number;
  if (section === 'payments') {
    amount = isCredit ? -abs : abs;
  } else {
    amount = isCredit ? abs : -abs;
  }

  return { date, merchantRaw, amount };
}

export const cibcCostcoMastercardParser: PdfParser = {
  id: 'cibc_costco_mastercard',
  label: 'CIBC Costco Mastercard',
  sniff: (lines) => lines.some((l) => l.text.includes('CIBC Costco Mastercard')),
  parse: () => {
    throw new Error('cibc_costco_mastercard parser not implemented yet');
  },
};
