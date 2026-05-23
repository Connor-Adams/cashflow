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
  return toIso(Number(m[3]), MONTHS[monthName], Number(m[2]));
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
    return {
      start: toIso(Number(both[3]), startMonth, Number(both[2])),
      end: toIso(Number(both[6]), endMonth, Number(both[5])),
    };
  }
  const abbrev = /([A-Z][a-z]+)\s+(\d{1,2})\s+to\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (abbrev) {
    const startMonth = MONTHS[abbrev[1].slice(0, 3)];
    const endMonth = MONTHS[abbrev[3].slice(0, 3)];
    const year = Number(abbrev[5]);
    return {
      start: toIso(year, startMonth, Number(abbrev[2])),
      end: toIso(year, endMonth, Number(abbrev[4])),
    };
  }
  return null;
}

export function parseCibcCostcoHeader(lines: PdfLine[]): CibcCostcoHeader {
  const page1 = lines.filter((l) => l.page === 1);

  // Statement date — labelled "Statement Date" on one line, value on the next or same line.
  let statementDate: string | null = null;
  for (let i = 0; i < page1.length; i++) {
    if (page1[i].text.includes('Statement Date')) {
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
    const m = /5160\s+X{4}\s+X{4}\s+(\d{4})/.exec(l.text);
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

export const cibcCostcoMastercardParser: PdfParser = {
  id: 'cibc_costco_mastercard',
  label: 'CIBC Costco Mastercard',
  sniff: (lines) => lines.some((l) => l.text.includes('CIBC Costco Mastercard')),
  parse: () => {
    throw new Error('cibc_costco_mastercard parser not implemented yet');
  },
};
