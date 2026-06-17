import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { MONTHS_SHORT, toIso, monthDayToIso, type Period } from './dateHelpers';

// Shared parsing core for American Express statement PDFs. The personal/Cobalt
// (`amex.ts`) and Aeroplan Reserve (`amexReserve.ts`) statements share an
// identical line layout — header line, section markers, two-date transaction
// rows, standalone amount lines, FX/reference continuation lines, and printed
// section totals. The only real differences are vendor sniffing, how the
// product label is derived, which date the transaction is dated on, and the
// FX-amount number-format handling. Those vary as factory options so the two
// parsers evolve together instead of drifting as duplicated copies.

export const AMEX_HEADER_RE =
  /^.*(XXXX\s+XXXXX\d)\s+(\d{5})\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*$/;

export const AMEX_ROW_RE =
  /^\s*([A-Z][a-z]{2}\s+\d{1,2})\s{2,}([A-Z][a-z]{2}\s+\d{1,2})\s{2,}(.+)$/;

export const AMEX_AMOUNT_RE = /^\s*(-?[\d,]+\.\d{2})\s*$/;

export const AMEX_FX_RE = /^\s*(.+?)\s+([\d,.]+)\s+@\s+([\d.]+)\s*$/;

export const AMEX_REF_RE = /^Reference\s+(\S+)/;

export type AmexSection = 'payments' | 'transactions' | 'other';

const SECTION_STARTS: Array<{ section: AmexSection; re: RegExp }> = [
  { section: 'payments', re: /^New Payments$/ },
  { section: 'transactions', re: /^New Transactions for / },
  { section: 'other', re: /^Other Account Transactions$/ },
];

const SECTION_TOTALS: Array<{ section: AmexSection; re: RegExp }> = [
  { section: 'payments', re: /^Total of Payment Activity/ },
  { section: 'transactions', re: /^Total of New Transactions for/ },
  { section: 'other', re: /^Total of Other Account Transactions/ },
];

const SKIP_LINES = [
  /^Transaction\b/,
  /^Date\b/,
  /^Posting\b/,
  /^Details\b/,
  /^Amount\b/,
  /^Page \d+/,
  /^Prepared For/,
  /^Your Transactions$/,
  /^Statement of Account$/,
  /^American Express/,
  /^ACCOUNT SUMMARY$/,
  /^Account Number/,
  /^Opening Date/,
  /^Closing Date/,
];

export function parseAmexHeaderDate(s: string): string {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (!m) throw new Error(`Amex header: unparseable date ${JSON.stringify(s)}`);
  const month = MONTHS_SHORT[m[1]];
  if (month === undefined) throw new Error(`Amex header: unknown month ${m[1]}`);
  return toIso(Number(m[3]), month, Number(m[2]));
}

export type AmexHeaderBase = {
  accountSuffix: string;
  periodStart: string;
  periodEnd: string;
  accountHolder: string;
};

/**
 * Parse the Amex account/period header line. Returns null when no header line
 * is present so callers can throw a vendor-specific message.
 */
export function parseAmexHeaderLine(lines: PdfLine[]): AmexHeaderBase | null {
  for (const l of lines.filter((l) => l.page === 1)) {
    const m = AMEX_HEADER_RE.exec(l.text);
    if (!m) continue;
    const accountSuffix = m[1].replace(/\s+/g, '').slice(-1) + m[2];
    const periodStart = parseAmexHeaderDate(m[3]);
    const periodEnd = parseAmexHeaderDate(m[4]);

    let accountHolder = '';
    const holderMatch = /^\s*(.+?)\s{3,}XXXX/.exec(l.text);
    if (holderMatch) accountHolder = holderMatch[1].trim();

    return { accountSuffix, periodStart, periodEnd, accountHolder };
  }
  return null;
}

function isAmountLine(l: PdfLine): boolean {
  if (!AMEX_AMOUNT_RE.test(l.text)) return false;
  if (!l.items || l.items.length === 0) return true;
  return l.items[0].x > 400;
}

export function parseAmexAmount(s: string): number {
  return Number(s.trim().replace(/,/g, ''));
}

type PendingTxn = {
  section: AmexSection;
  rowIndex: number;
  transDate: string;
  postDate: string;
  merchantRaw: string;
  // null until the standalone amount line is matched — a 0 sentinel would
  // both import unmatched rows as $0.00 and let a stray later amount line
  // attach to a genuine $0.00 row.
  amount: number | null;
  sourceReference: string | null;
  fxCurrency: string | null;
  fxAmount: number | null;
  fxRate: number | null;
};

export type AmexParserOptions = {
  id: string;
  label: string;
  /** Does this PDF belong to this parser? */
  sniff: (lines: PdfLine[]) => boolean;
  /** Resolve the header (suffix/period/holder) — throws a vendor-specific error when absent. */
  resolveHeader: (lines: PdfLine[]) => AmexHeaderBase;
  /** Product label written onto the statement header. */
  productLabel: (lines: PdfLine[]) => string;
  /** Parse an FX original-amount string into a number. */
  parseFxAmount: (s: string) => number;
  /** Which date a transaction is recorded on. Defaults to the transaction date. */
  txnDate?: (row: { transDate: string; postDate: string }) => string;
};

/**
 * Build an Amex statement `PdfParser` from the per-variant options. The body of
 * the parse loop is identical across Amex variants; only the options differ.
 */
export function createAmexParser(opts: AmexParserOptions): PdfParser {
  const pickDate = opts.txnDate ?? ((row) => row.transDate);

  return {
    id: opts.id,
    label: opts.label,
    sniff: opts.sniff,

    parse: (lines, ctx) => {
      const hdr = opts.resolveHeader(lines);
      const productLabel = opts.productLabel(lines);
      const period: Period = { start: hdr.periodStart, end: hdr.periodEnd };

      const txnSections: AmexSection[] = [];
      const transactions: PdfParseResult['transactions'] = [];
      const warnings: string[] = [];
      const parseErrors: PdfParseResult['parseErrors'] = [];

      let currentSection: AmexSection | null = null;
      let pending: PendingTxn | null = null;

      const printedTotals: Partial<Record<AmexSection, number>> = {};

      function flush(): void {
        if (!pending) return;
        const row = pending;
        pending = null;
        if (row.amount === null) {
          // No amount line ever matched this row (layout drift, malformed
          // amount) — surface it instead of importing a $0.00 transaction.
          parseErrors.push({
            rowIndex: row.rowIndex,
            message: `No amount line found for transaction "${row.merchantRaw}" (${row.transDate})`,
          });
          return;
        }
        // Negate: Amex PDF positive = charge, negative = credit/payment.
        // Cashflow credit-card convention: positive = money in, negative = money out.
        // (A genuine $0.00 row would negate to -0 — normalize to 0.)
        const amount = row.amount === 0 ? 0 : -row.amount;

        let merchantRaw = row.merchantRaw;
        if (row.fxCurrency && row.fxAmount != null && row.fxRate != null) {
          merchantRaw += ` [${row.fxCurrency} ${row.fxAmount.toFixed(2)} @ ${row.fxRate}]`;
        }

        txnSections.push(row.section);
        transactions.push({
          date: pickDate({ transDate: row.transDate, postDate: row.postDate }),
          merchantRaw,
          merchantClean: normalizeMerchant(row.merchantRaw),
          amount,
          currency: ctx.defaultCurrency,
          sourceReference: row.sourceReference,
        });
      }

      // Skip account holder name lines dynamically
      const holderName = hdr.accountHolder;
      const holderRe = holderName
        ? new RegExp(`^${holderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
        : null;

      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const text = l.text.trim();
        if (!text) continue;

        const sectionStart = SECTION_STARTS.find((s) => s.re.test(text));
        if (sectionStart) {
          flush();
          currentSection = sectionStart.section;
          continue;
        }

        const sectionTotal = SECTION_TOTALS.find((s) => s.re.test(text));
        if (sectionTotal) {
          flush();
          const m = /(-?[\d,]+\.\d{2})\s*$/.exec(text);
          if (m) printedTotals[sectionTotal.section] = parseAmexAmount(m[1]);
          currentSection = null;
          continue;
        }

        if (!currentSection) continue;
        if (SKIP_LINES.some((re) => re.test(text))) continue;
        if (holderRe && holderRe.test(text)) continue;

        if (isAmountLine(l)) {
          if (pending && pending.amount === null) {
            pending.amount = parseAmexAmount(text);
          }
          continue;
        }

        const fxMatch = AMEX_FX_RE.exec(text);
        if (fxMatch && pending) {
          pending.fxCurrency = fxMatch[1].trim();
          pending.fxAmount = opts.parseFxAmount(fxMatch[2]);
          pending.fxRate = Number(fxMatch[3]);
          continue;
        }

        const refMatch = AMEX_REF_RE.exec(text);
        if (refMatch && pending) {
          pending.sourceReference = refMatch[1];
          continue;
        }

        const rowMatch = AMEX_ROW_RE.exec(text);
        if (rowMatch) {
          flush();
          try {
            const transDate = monthDayToIso(rowMatch[1], period);
            const postDate = monthDayToIso(rowMatch[2], period);
            pending = {
              section: currentSection,
              rowIndex: i + 1,
              transDate,
              postDate,
              merchantRaw: rowMatch[3].trim(),
              amount: null,
              sourceReference: null,
              fxCurrency: null,
              fxAmount: null,
              fxRate: null,
            };
          } catch (err) {
            parseErrors.push({ rowIndex: i + 1, message: (err as Error).message });
          }
          continue;
        }
      }
      flush();

      // Cross-check parsed sums against printed section totals
      const sectionSums: Partial<Record<AmexSection, number>> = {};
      for (let i = 0; i < transactions.length; i++) {
        const sec = txnSections[i];
        // Sum in PDF sign convention (negate back)
        sectionSums[sec] = (sectionSums[sec] ?? 0) + -transactions[i].amount;
      }

      for (const sec of ['payments', 'transactions', 'other'] as AmexSection[]) {
        const printed = printedTotals[sec];
        const parsed = sectionSums[sec];
        if (printed !== undefined && parsed !== undefined) {
          const diff = Math.abs(printed - parsed);
          if (diff > 0.02) {
            warnings.push(
              `Section "${sec}" sum mismatch: parsed ${parsed.toFixed(2)} vs printed ${printed.toFixed(2)}`,
            );
          }
        }
      }

      return {
        transactions,
        warnings,
        parseErrors,
        header: {
          accountSuffix: hdr.accountSuffix,
          productLabel,
          accountType: 'credit_card',
          periodStart: hdr.periodStart,
          periodEnd: hdr.periodEnd,
          accountHolder: hdr.accountHolder || undefined,
        } as PdfStatementHeader,
      };
    },
  };
}
