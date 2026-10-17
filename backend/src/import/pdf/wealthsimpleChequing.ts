import type { PdfLine, PdfParseResult, PdfParser, PdfStatementHeader, StatementParseError } from './types';
import { rbcBankingResult } from './rbcBankingResult';

/**
 * Wealthsimple chequing monthly statement (personal and Business).
 *
 * Layout — one line per transaction, five columns:
 *
 *   DATE   POSTED DATE   DESCRIPTION   AMOUNT (CAD)   BALANCE (CAD)
 *   2026-08-02   2026-08-03   Deposit   $14,500.00   $24,802.33
 *   2026-08-03   2026-08-03   Transfer out to Chequing   –$1,000.00   $23,802.33
 *
 * Two details that bite:
 *
 * 1. The minus sign is an EN DASH (U+2013), not a hyphen. Matching only '-'
 *    turns every withdrawal into a deposit.
 * 2. We take the TRANSACTION date, not the posted date — even though the
 *    statement's own footnote recommends the posted date "for accounting
 *    purposes". Wealthsimple's CSV export of the same account uses the
 *    transaction date, and dedup keys on date: parsing a statement for a month
 *    already loaded from CSV would otherwise duplicate every row whose posting
 *    lagged a day. Consistency with the other ingest path wins.
 *
 * 3. pdfjs sometimes splits a pair of 1s with a kerning gap — "$11,305.92"
 *    arrives as "$1 1,305.92", "2026-09-11" as "2026-09-1 1". `joinSplitDigits`
 *    closes those gaps inside dates and money before matching. Columns are
 *    separated by 2+ spaces, so a single space between digits is never a
 *    column boundary.
 *
 * The statement's summary prints the period's opening and closing balance;
 * the result runs the shared reconciliation gate on them, so a row the
 * pattern misses blocks the import instead of silently shortening it.
 *
 * The body prints an internal account number, whose last 4 become
 * `accountSuffix`. That is NOT the stable Wealthsimple account id — the WSID
 * lives in the filename (`WK79NVW07CAD_…`), and `resolvePdfAccountFromHeader`
 * prefers it, so a corporate statement lands on the corporate account instead
 * of the same-named personal one.
 */

const TITLE_RE = /^chequing monthly statement$/i;
const BRAND_RE = /wealthsimple/i;
// " Wealthsimple    Aug 1 - Aug 31, 2026"
const PERIOD_RE =
  /Wealthsimple\s+([A-Z][a-z]{2})\s+(\d{1,2})\s*[-–—]\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/;
const ACCOUNT_NUMBER_RE = /Account number:\s*(\d+)/i;
const CURRENCY_RE = /AMOUNT\s*\(([A-Z]{3})\)/;
// date, posted date, description, amount, balance. The dash class covers the
// EN/EM dashes Wealthsimple uses for negatives as well as a plain hyphen.
const ROW_RE =
  /^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s{2,}([–—-]?)\$([\d,]+\.\d{2})\s{2,}[–—-]?\$[\d,]+\.\d{2}$/;

// A line that starts with a transaction date — anything like this that ROW_RE
// cannot read is reported rather than dropped.
const DATED_LINE_RE = /^\d{4}-\d{2}-\d{2}\s/;
// The summary's balance pair: " $1,303.65      $2,802.94" under "SEP 1 BALANCE   SEP 30 BALANCE".
const BALANCE_HEADER_RE = /^\s*[A-Z]{3}\s+\d{1,2}\s+BALANCE\s{2,}[A-Z]{3}\s+\d{1,2}\s+BALANCE\s*$/;
const BALANCE_PAIR_RE = /^\s*([–—-]?)\$([\d,]+\.\d{2})\s{2,}([–—-]?)\$([\d,]+\.\d{2})\s*$/;

/** Close single-space kerning gaps inside dates ("2026-09-1 1") and money ("$1 1,305.92"). */
function joinSplitDigits(text: string): string {
  let prev: string;
  let out = text;
  do {
    prev = out;
    out = out
      .replace(/(\d{4}-\d{2}-\d) (\d)/g, '$1$2')
      .replace(/(\$[\d,]*\d) ([\d,]*\d\.\d{2})/g, '$1$2')
      .replace(/(\$[\d,]*\.\d) (\d)/g, '$1$2');
  } while (out !== prev);
  return out;
}

function signedMoney(dash: string, digits: string): number {
  const magnitude = Number(digits.replace(/,/g, ''));
  return dash === '' ? magnitude : -magnitude;
}

/** Opening and closing balance from the summary block, or nulls when absent. */
function extractSummaryBalances(lines: PdfLine[]): { opening: number | null; closing: number | null } {
  for (let i = 0; i < lines.length; i++) {
    if (!BALANCE_HEADER_RE.test(lines[i].text)) continue;
    for (const next of lines.slice(i + 1, i + 4)) {
      const m = BALANCE_PAIR_RE.exec(joinSplitDigits(next.text));
      if (m) return { opening: signedMoney(m[1], m[2]), closing: signedMoney(m[3], m[4]) };
    }
  }
  return { opening: null, closing: null };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseWsChequingHeader(lines: PdfLine[]): PdfStatementHeader {
  const periodLine = lines.find((l) => PERIOD_RE.test(l.text));
  const m = periodLine ? PERIOD_RE.exec(periodLine.text) : null;
  if (!m) throw new Error('WS chequing header: could not find the statement period');
  const startMonth = MONTHS[m[1].toLowerCase()];
  const endMonth = MONTHS[m[3].toLowerCase()];
  if (!startMonth || !endMonth) {
    throw new Error(`WS chequing header: unrecognised month in "${m[0]}"`);
  }
  const endYear = Number(m[5]);
  // A period that runs Dec → Jan starts in the previous year; the statement
  // prints only the end year.
  const startYear = startMonth > endMonth ? endYear - 1 : endYear;

  const accountLine = lines.find((l) => ACCOUNT_NUMBER_RE.test(l.text));
  const accountNumber = accountLine
    ? (ACCOUNT_NUMBER_RE.exec(accountLine.text)?.[1] ?? '')
    : '';

  const currencyLine = lines.find((l) => CURRENCY_RE.test(l.text));
  const currency = currencyLine ? CURRENCY_RE.exec(currencyLine.text)?.[1] : undefined;

  // The account holder is the line directly beneath the brand/period line —
  // "CDG Labs Inc." on a Business statement, the person's name on a personal one.
  const periodIdx = periodLine ? lines.indexOf(periodLine) : -1;
  const holder = periodIdx >= 0
    ? lines.slice(periodIdx + 1).find((l) => l.text.trim() !== '')?.text.trim()
    : undefined;

  return {
    accountSuffix: accountNumber.slice(-4),
    productLabel: 'Wealthsimple Chequing',
    accountType: 'checking',
    periodStart: iso(startYear, startMonth, Number(m[2])),
    periodEnd: iso(endYear, endMonth, Number(m[4])),
    currency: currency ?? undefined,
    accountHolder: holder,
  };
}

export const wealthsimpleChequingParser: PdfParser = {
  id: 'wealthsimple_chequing',
  label: 'Wealthsimple chequing statement',
  sniff: (lines) =>
    lines.some((l) => TITLE_RE.test(l.text.trim()))
    && lines.some((l) => BRAND_RE.test(l.text)),
  parse: (lines, ctx): PdfParseResult => {
    const header = parseWsChequingHeader(lines);
    const currency = header.currency ?? ctx.defaultCurrency;
    const rows: Array<{ date: string; description: string; amount: number }> = [];
    const parseErrors: StatementParseError[] = [];
    lines.forEach((line, idx) => {
      const text = joinSplitDigits(line.text.trim());
      const row = ROW_RE.exec(text);
      if (!row) {
        if (DATED_LINE_RE.test(text)) {
          parseErrors.push({ rowIndex: idx + 1, message: `Could not read transaction line: ${text}` });
        }
        return;
      }
      // The statement prints no per-row identifier, so dedup falls back to
      // the identity fingerprint (account + date + amount + description).
      rows.push({ date: row[1], description: row[3].trim(), amount: signedMoney(row[4], row[5]) });
    });

    // No summary block → closingBalance null, and the shared result reports
    // the gate as skipped instead of reconciling against a made-up opening.
    const { opening, closing } = extractSummaryBalances(lines);
    return rbcBankingResult({
      header,
      rows,
      parseErrors,
      openingBalance: opening ?? 0,
      closingBalance: opening === null ? null : closing,
      currency,
    });
  },
};
