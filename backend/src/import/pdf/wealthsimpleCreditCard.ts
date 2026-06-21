import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import type { TxnType } from '../enrichment/types';
import { normalizeMerchant } from '../normalizeMerchant';

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function toIso(year: number, monthZeroBased: number, day: number): string {
  return `${year}-${String(monthZeroBased + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

type Period = { start: string; end: string };

// "Apr 15 — May 14, 2026"  (em/en dash). Start month/day, end month/day/year.
const PERIOD_RE =
  /([A-Z][a-z]{2})\s+(\d{1,2})\s*[—–-]\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/;

function parsePeriod(lines: PdfLine[]): Period {
  for (const l of lines) {
    const m = PERIOD_RE.exec(l.text);
    if (!m) continue;
    const startMonth = MONTHS[m[1]];
    const endMonth = MONTHS[m[3]];
    if (startMonth === undefined || endMonth === undefined) continue;
    const endYear = Number(m[5]);
    // Start year = endYear unless the range crosses a Dec→Jan boundary.
    const startYear = startMonth > endMonth ? endYear - 1 : endYear;
    return {
      start: toIso(startYear, startMonth, Number(m[2])),
      end: toIso(endYear, endMonth, Number(m[4])),
    };
  }
  throw new Error('WS credit card: could not parse statement period');
}

function parseLast4(lines: PdfLine[]): string {
  for (const l of lines) {
    const m = /\b\d{4}\s+\d{2}\*{2}\s+\*{4}\s+(\d{4})\b/.exec(l.text);
    if (m) return m[1];
  }
  throw new Error('WS credit card: could not parse card last-4');
}

// "$1,234.56" → 1234.56; null when no money token present.
function parseSummaryMoney(lines: PdfLine[], label: RegExp): number | null {
  for (const l of lines) {
    const m = label.exec(l.text);
    if (m) {
      const n = Number(m[1].replace(/[,\s]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

// "Jun 11, 2026" → "2026-06-11"; null when missing/unparseable.
function parseSummaryDate(lines: PdfLine[], label: RegExp): string | null {
  for (const l of lines) {
    const m = label.exec(l.text);
    if (!m) continue;
    const month = MONTHS[m[1]];
    if (month === undefined) return null;
    return toIso(Number(m[3]), month, Number(m[2]));
  }
  return null;
}

export function parseWsCreditCardHeader(lines: PdfLine[]): PdfStatementHeader {
  const period = parsePeriod(lines);
  return {
    accountSuffix: parseLast4(lines),
    productLabel: 'Wealthsimple Credit Card',
    accountType: 'credit_card',
    periodStart: period.start,
    periodEnd: period.end,
    currency: 'CAD',
    statementBalance: parseSummaryMoney(lines, /New balance\s+\$?([\d,]+\.\d{2})/),
    minimumPayment: parseSummaryMoney(lines, /Minimum payment\s+\$?([\d,]+\.\d{2})/),
    paymentDueDate: parseSummaryDate(lines, /Payment due date\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/),
  };
}

const MONTH_DAY_RE = /^([A-Z][a-z]{2})\s+(\d{1,2})\b/;

function inferYear(monthZeroBased: number, period: Period): number {
  const startYear = Number(period.start.slice(0, 4));
  const endYear = Number(period.end.slice(0, 4));
  if (startYear === endYear) return startYear;
  // Range crosses Dec→Jan: months >= start-month belong to startYear.
  const startMonth = Number(period.start.slice(5, 7)) - 1;
  return monthZeroBased >= startMonth ? startYear : endYear;
}

function rowDate(monthDay: string, period: Period): string {
  const m = MONTH_DAY_RE.exec(monthDay.trim());
  if (!m) throw new Error(`WS credit card: unparseable date cell ${JSON.stringify(monthDay)}`);
  const month = MONTHS[m[1]];
  if (month === undefined) throw new Error(`WS credit card: unknown month ${m[1]}`);
  return toIso(inferYear(month, period), month, Number(m[2]));
}

// Amount like "$10.49" or "–$4,404.43" (U+2013) or "-$4,404.43".
function parseAmount(raw: string): { magnitude: number; isCredit: boolean } {
  const isCredit = /^[–-]/.test(raw.trim());
  const n = Number(raw.replace(/[–\-$,\s]/g, ''));
  return { magnitude: n, isCredit };
}

const TYPE_RE = /\b(Purchase|Payment|Refund|Reversal|Interest|Fee|Cash advance)\b/i;

/**
 * Map the credit-card statement TYPE column to the authoritative `TxnType`.
 * Stamped onto overrideTxnType so the commit pipeline types the row by the
 * printed type instead of guessing from the narrative. Unknown types (e.g.
 * "Cash advance", "Reversal") return undefined → let enrichment decide.
 */
function ccTypeToTxnType(type: string): TxnType | undefined {
  switch (type.trim().toLowerCase()) {
    case 'purchase': return 'purchase';
    case 'payment': return 'payment';
    case 'refund': return 'refund';
    case 'interest': return 'interest';
    case 'fee': return 'fee';
    default: return undefined; // e.g. cash advance → let enrichment decide
  }
}

export const wealthsimpleCreditCardParser: PdfParser = {
  id: 'wealthsimple_credit_card',
  label: 'Wealthsimple Credit Card',
  sniff: (lines) => {
    let cc = false;
    let ws = false;
    for (const l of lines) {
      if (l.text.includes('Credit card statement')) cc = true;
      if (/Wealthsimple/.test(l.text)) ws = true;
      if (cc && ws) return true;
    }
    return false;
  },
  parse: (lines, ctx): PdfParseResult => {
    const header = parseWsCreditCardHeader(lines);
    const period: Period = { start: header.periodStart, end: header.periodEnd };
    const transactions: PdfParseResult['transactions'] = [];
    const warnings: string[] = [];
    const parseErrors: PdfParseResult['parseErrors'] = [];

    let idx = 0;
    let parsedPurchases = 0;
    for (const l of lines) {
      const cols = l.text.trim().split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
      // A data row starts with two "Mon DD" date columns.
      if (cols.length < 4) continue;
      if (!MONTH_DAY_RE.test(cols[0]) || !MONTH_DAY_RE.test(cols[1])) continue;
      if (!TYPE_RE.test(cols[2])) continue;
      idx += 1;
      try {
        const merchantRaw = cols.slice(3, cols.length - 1).join(' ').replace(/\s+/g, ' ').trim();
        const { magnitude, isCredit } = parseAmount(cols[cols.length - 1]);
        if (!Number.isFinite(magnitude)) {
          throw new Error(`unparseable amount ${JSON.stringify(cols[cols.length - 1])}`);
        }
        const abs = Math.abs(magnitude);
        // Cashflow convention: positive = credit, negative = charge.
        // Payments/refunds (printed with leading "–") are credits → positive.
        // Purchases (printed positive) are charges → negative.
        const amount = isCredit ? abs : -abs;
        transactions.push({
          date: rowDate(cols[0], period),
          merchantRaw,
          merchantClean: normalizeMerchant(merchantRaw),
          amount,
          currency: ctx.defaultCurrency,
          sourceReference: null,
          // TYPE column (cols[2]) authoritatively types the row.
          overrideTxnType: ccTypeToTxnType(cols[2]),
        });
        // Bug 1 fix: only count rows whose Activity TYPE is "Purchase" toward the
        // Purchases reconciliation total (fees have their own "+ Fees" line).
        if (/^Purchase$/i.test(cols[2])) {
          parsedPurchases += abs;
        }
      } catch (err) {
        parseErrors.push({ rowIndex: idx, message: (err as Error).message });
      }
    }

    const purchasesTotal = (() => {
      for (const l of lines) {
        // Bug 2 fix: allow spaces inside the dollar figure (pdfjs space artifacts).
        const m = /Purchases\s+\$([\d,\s]+\.\d{2})/.exec(l.text);
        if (m) return Number(m[1].replace(/[,\s]/g, ''));
      }
      return null;
    })();
    if (purchasesTotal != null) {
      if (Math.abs(parsedPurchases - purchasesTotal) > 0.01) {
        warnings.push(
          `Purchases total mismatch: parsed ${parsedPurchases.toFixed(2)} vs statement ${purchasesTotal.toFixed(2)}`,
        );
      }
    }

    return {
      transactions,
      header,
      warnings,
      parseErrors,
    };
  },
};
