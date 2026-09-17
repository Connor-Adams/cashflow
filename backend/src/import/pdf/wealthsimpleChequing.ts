import type { PdfLine, PdfParseResult, PdfParser, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';

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
    const transactions = [];
    for (const line of lines) {
      const row = ROW_RE.exec(line.text.trim());
      if (!row) continue;
      const description = row[3].trim();
      const magnitude = Number(row[5].replace(/,/g, ''));
      if (!Number.isFinite(magnitude)) continue;
      transactions.push({
        date: row[1],
        merchantRaw: description,
        merchantClean: normalizeMerchant(description),
        amount: row[4] === '' ? magnitude : -magnitude,
        currency,
        // The statement prints no per-row identifier, so dedup falls back to
        // the identity fingerprint (account + date + amount + description).
        sourceReference: null,
      });
    }
    return { transactions, header, warnings: [], parseErrors: [] };
  },
};
