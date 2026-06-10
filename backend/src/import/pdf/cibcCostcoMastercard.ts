import type { PdfLine, PdfParser, PdfParseResult } from './types';
import { normalizeMerchant } from '../normalizeMerchant';

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

function findStatementDate(page1: PdfLine[]): string | null {
  for (let i = 0; i < page1.length; i++) {
    if (!/statement date/i.test(page1[i].text)) continue;
    const sameLine = parseLongDate(page1[i].text);
    if (sameLine) return sameLine;
    const next = page1[i + 1]?.text ?? '';
    const nextParsed = parseLongDate(next);
    if (nextParsed) return nextParsed;
  }
  return null;
}

function findPeriodFromHeader(page1: PdfLine[]): { start: string; end: string } | null {
  for (let i = 0; i < page1.length; i++) {
    if (!/statement period/i.test(page1[i].text)) continue;
    const found = parsePeriod(page1[i].text) || parsePeriod(page1[i + 1]?.text ?? '');
    if (found) return found;
  }
  return null;
}

function findPeriodFromTransactionsHeader(lines: PdfLine[]): { start: string; end: string } | null {
  for (const l of lines) {
    const m = /Transactions from\s+(.+)/.exec(l.text);
    if (!m) continue;
    const found = parsePeriod(m[1]);
    if (found) return found;
  }
  return null;
}

function findPeriod(lines: PdfLine[]): { start: string; end: string } | null {
  return findPeriodFromHeader(lines.filter((l) => l.page === 1))
    ?? findPeriodFromTransactionsHeader(lines);
}

function findAccountLast4(page1: PdfLine[]): string | null {
  for (const l of page1) {
    const m = /5160\s+[Xx]{4}\s+[Xx]{4}\s+(\d{4})/.exec(l.text);
    if (m) return m[1];
  }
  return null;
}

export function parseCibcCostcoHeader(lines: PdfLine[]): CibcCostcoHeader {
  const page1 = lines.filter((l) => l.page === 1);
  const statementDate = findStatementDate(page1);
  if (!statementDate) throw new Error('CIBC Costco header: could not parse Statement Date');
  const period = findPeriod(lines);
  if (!period) throw new Error('CIBC Costco header: could not parse statement period');
  const last4 = findAccountLast4(page1);
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

type ParsedAmount = { magnitude: number; isCredit: boolean };

function parseRowAmount(amountStr: string): ParsedAmount {
  const cleaned = amountStr.replace(/[$,]/g, '').trim();
  const crMatch = /^(-?)([\d.]+)\s*CR$/i.exec(cleaned);
  if (crMatch) return { magnitude: Number(crMatch[2]), isCredit: true };
  const n = Number(cleaned);
  return { magnitude: n, isCredit: cleaned.startsWith('-') };
}

function applySectionSign(magnitude: number, isCredit: boolean, section: CibcCostcoSection): number {
  const abs = Math.abs(magnitude);
  if (section === 'payments') return isCredit ? -abs : abs;
  return isCredit ? abs : -abs;
}

function rowDateFromPost(postDate: string, period: Period): string {
  const year = inferYearForMonthDay(postDate, period);
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(postDate);
  if (!m) throw new Error(`Unparseable post date: ${postDate}`);
  const month = MONTHS[m[1]];
  if (month === undefined) throw new Error(`Unknown month abbreviation: ${m[1]}`);
  return toIso(year, month, Number(m[2]));
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
  const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);
  const minCols = section === 'payments' ? 3 : 5;
  if (cols.length < minCols) {
    throw new Error(
      `CIBC Costco row has too few columns (need ${minCols}, got ${cols.length}) — likely a collapsed column gap: ${JSON.stringify(rawLine)}`,
    );
  }
  const middleEnd = section === 'payments' ? cols.length - 1 : cols.length - 2;
  const merchantRaw = cols.slice(2, middleEnd).join(' ').replace(/\s*Ý\s+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!merchantRaw) {
    throw new Error(`CIBC Costco row: empty merchant after column extraction: ${JSON.stringify(rawLine)}`);
  }
  const date = rowDateFromPost(cols[1], period);
  const { magnitude, isCredit } = parseRowAmount(cols[cols.length - 1]);
  if (!Number.isFinite(magnitude)) {
    throw new Error(`CIBC Costco row has unparseable amount: ${JSON.stringify(cols[cols.length - 1])}`);
  }
  return { date, merchantRaw, amount: applySectionSign(magnitude, isCredit, section) };
}

const SECTION_HEADERS: Record<CibcCostcoSection, RegExp> = {
  payments: /^Your payments$/,
  interest: /^Your interest$/,
  charges: /^Your new charges and credits$/,
};

const SECTION_TOTAL_PATTERNS: Record<CibcCostcoSection, RegExp> = {
  payments: /^Total payments/i,
  interest: /^Total interest/i,
  charges: /^Total for /i,
};

const SECTION_SKIP_PATTERNS: RegExp[] = [
  /^Trans\s*$/, /^Post\s*$/, /^date\b/, /^Description\b/, /^Amount\(\$\)/,
  /^Spend Categories/, /^Annual interest rate/,
  /^Card number 5160 X{4} X{4} \d{4}$/,
  /^Ý Identifies transactions/, /^same rate\.$/,
];

function splitSections(lines: PdfLine[]): Record<CibcCostcoSection, PdfLine[]> {
  const buckets: Record<CibcCostcoSection, PdfLine[]> = {
    payments: [], interest: [], charges: [],
  };
  let current: CibcCostcoSection | null = null;
  for (const line of lines) {
    const trimmed = line.text.trim();

    const startedHere = (Object.keys(SECTION_HEADERS) as CibcCostcoSection[])
      .find((s) => SECTION_HEADERS[s].test(trimmed));
    if (startedHere) { current = startedHere; continue; }

    if (current) {
      if (SECTION_TOTAL_PATTERNS[current].test(trimmed)) {
        current = null;
        continue;
      }
      if (SECTION_SKIP_PATTERNS.some((re) => re.test(trimmed))) continue;
      if (/^[A-Z][a-z]{2}\s+\d{1,2}\s/.test(trimmed)) {
        buckets[current].push(line);
      }
    }
  }
  return buckets;
}

function stripProvinceSuffix(s: string): string {
  return s.replace(/\s+(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/, '');
}

export const cibcCostcoMastercardParser: PdfParser = {
  id: 'cibc_costco_mastercard',
  label: 'CIBC Costco Mastercard',
  sniff: (lines) => lines.some((l) => l.text.includes('CIBC Costco Mastercard')),
  parse: (lines, ctx) => {
    const header = parseCibcCostcoHeader(lines);
    const period: Period = { start: header.periodStart, end: header.periodEnd };
    const sections = splitSections(lines);

    const transactions: PdfParseResult['transactions'] = [];
    const warnings: string[] = [];
    const parseErrors: PdfParseResult['parseErrors'] = [];

    const sectionTotals: Partial<Record<CibcCostcoSection, number>> = {};
    for (const line of lines) {
      const t = line.text.trim();
      for (const sec of Object.keys(SECTION_TOTAL_PATTERNS) as CibcCostcoSection[]) {
        if (SECTION_TOTAL_PATTERNS[sec].test(t)) {
          const m = /\$?([\d,]+\.\d{2})\s*(CR)?$/.exec(t);
          if (m) {
            const v = Number(m[1].replace(/,/g, ''));
            sectionTotals[sec] = m[2] ? -v : v;
          }
        }
      }
    }

    (Object.keys(sections) as CibcCostcoSection[]).forEach((sec) => {
      let parsedSum = 0;
      for (let i = 0; i < sections[sec].length; i++) {
        const line = sections[sec][i];
        try {
          const row = parseCibcCostcoRow(line.text, period, sec);
          const merchantStripped = stripProvinceSuffix(row.merchantRaw).trim();
          const merchantClean = normalizeMerchant(merchantStripped);
          transactions.push({
            date: row.date,
            merchantRaw: row.merchantRaw,
            merchantClean,
            amount: row.amount,
            currency: ctx.defaultCurrency,
            sourceReference: null,
          });
          // Accumulate in the statement's own sign convention: the printed
          // "Total for …" is NET (charges minus CR credits), and "payments"
          // is the only section whose rows map to positive cashflow amounts.
          // Summing absolute values would false-alarm on any CR credit and
          // could never catch a sign-flip bug.
          parsedSum += sec === 'payments' ? row.amount : -row.amount;
        } catch (err) {
          parseErrors.push({ rowIndex: i + 1, message: (err as Error).message });
        }
      }
      const total = sectionTotals[sec];
      if (total !== undefined) {
        const diff = Math.abs(total - parsedSum);
        if (diff > 0.01) {
          warnings.push(
            `Section "${sec}" sum mismatch: parsed ${parsedSum.toFixed(2)} vs printed total ${total.toFixed(2)}`,
          );
        }
      }
    });

    return { transactions, warnings, parseErrors };
  },
};
