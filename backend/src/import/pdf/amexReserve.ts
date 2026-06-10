import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { MONTHS_SHORT, toIso, monthDayToIso, type Period } from './dateHelpers';

const SNIFF_RE = /American Express®.*Reserve Card/;

const HEADER_RE =
  /^.*(XXXX\s+XXXXX\d)\s+(\d{5})\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*$/;

const ROW_RE =
  /^\s*([A-Z][a-z]{2}\s+\d{1,2})\s{2,}([A-Z][a-z]{2}\s+\d{1,2})\s{2,}(.+)$/;

const AMOUNT_RE = /^\s*(-?[\d,]+\.\d{2})\s*$/;

const FX_RE = /^\s*(.+?)\s+([\d,.]+)\s+@\s+([\d.]+)\s*$/;

const REF_RE = /^Reference\s+(\S+)/;

type Section = 'payments' | 'transactions' | 'other';

const SECTION_STARTS: Array<{ section: Section; re: RegExp }> = [
  { section: 'payments', re: /^New Payments$/ },
  { section: 'transactions', re: /^New Transactions for / },
  { section: 'other', re: /^Other Account Transactions$/ },
];

const SECTION_TOTALS: Array<{ section: Section; re: RegExp }> = [
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
  /^American Express®/,
  /^ACCOUNT SUMMARY$/,
  /^Account Number/,
  /^Opening Date/,
  /^Closing Date/,
];

function parseHeaderDate(s: string): string {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (!m) throw new Error(`Amex header: unparseable date ${JSON.stringify(s)}`);
  const month = MONTHS_SHORT[m[1]];
  if (month === undefined) throw new Error(`Amex header: unknown month ${m[1]}`);
  return toIso(Number(m[3]), month, Number(m[2]));
}

export type AmexReserveHeader = {
  accountSuffix: string;
  periodStart: string;
  periodEnd: string;
  accountHolder: string;
};

export function parseAmexReserveHeader(lines: PdfLine[]): AmexReserveHeader {
  let accountHolder = '';

  for (const l of lines.filter((l) => l.page === 1)) {
    const m = HEADER_RE.exec(l.text);
    if (!m) continue;
    const accountSuffix = m[1].replace(/\s+/g, '').slice(-1) + m[2];
    const periodStart = parseHeaderDate(m[3]);
    const periodEnd = parseHeaderDate(m[4]);

    const holderMatch = /^\s*(.+?)\s{3,}XXXX/.exec(l.text);
    if (holderMatch) accountHolder = holderMatch[1].trim();

    return { accountSuffix, periodStart, periodEnd, accountHolder };
  }
  throw new Error('Amex Reserve header: could not find account/period line');
}

function isAmountLine(l: PdfLine): boolean {
  if (!AMOUNT_RE.test(l.text)) return false;
  if (!l.items || l.items.length === 0) return true;
  return l.items[0].x > 400;
}

function parseAmount(s: string): number {
  return Number(s.trim().replace(/,/g, ''));
}

/** Parse FX original amount — handles European comma-as-decimal (e.g. "19,00" = 19.00). */
function parseFxAmount(s: string): number {
  const trimmed = s.trim();
  if (!trimmed.includes('.') && /,\d{2}$/.test(trimmed)) {
    return Number(trimmed.replace(',', '.'));
  }
  return parseAmount(trimmed);
}

type PendingTxn = {
  section: Section;
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

export const amexReserveParser: PdfParser = {
  id: 'amex_reserve',
  label: 'American Express Aeroplan Reserve',
  sniff: (lines) => lines.some((l) => SNIFF_RE.test(l.text)),

  parse: (lines, ctx) => {
    const hdr = parseAmexReserveHeader(lines);
    const period: Period = { start: hdr.periodStart, end: hdr.periodEnd };

    const txnSections: Section[] = [];
    const transactions: PdfParseResult['transactions'] = [];
    const warnings: string[] = [];
    const parseErrors: PdfParseResult['parseErrors'] = [];

    let currentSection: Section | null = null;
    let pending: PendingTxn | null = null;

    const printedTotals: Partial<Record<Section, number>> = {};

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
        date: row.postDate,
        merchantRaw,
        merchantClean: normalizeMerchant(row.merchantRaw),
        amount,
        currency: ctx.defaultCurrency,
        sourceReference: row.sourceReference,
      });
    }

    // Skip account holder name lines dynamically
    const holderName = hdr.accountHolder;
    const holderRe = holderName ? new RegExp(`^${holderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : null;

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
        if (m) printedTotals[sectionTotal.section] = parseAmount(m[1]);
        currentSection = null;
        continue;
      }

      if (!currentSection) continue;
      if (SKIP_LINES.some((re) => re.test(text))) continue;
      if (holderRe && holderRe.test(text)) continue;

      if (isAmountLine(l)) {
        if (pending && pending.amount === null) {
          pending.amount = parseAmount(text);
        }
        continue;
      }

      const fxMatch = FX_RE.exec(text);
      if (fxMatch && pending) {
        pending.fxCurrency = fxMatch[1].trim();
        pending.fxAmount = parseFxAmount(fxMatch[2]);
        pending.fxRate = Number(fxMatch[3]);
        continue;
      }

      const refMatch = REF_RE.exec(text);
      if (refMatch && pending) {
        pending.sourceReference = refMatch[1];
        continue;
      }

      const rowMatch = ROW_RE.exec(text);
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
    const sectionSums: Partial<Record<Section, number>> = {};
    for (let i = 0; i < transactions.length; i++) {
      const sec = txnSections[i];
      // Sum in PDF sign convention (negate back)
      sectionSums[sec] = (sectionSums[sec] ?? 0) + (-transactions[i].amount);
    }

    for (const sec of ['payments', 'transactions', 'other'] as Section[]) {
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
        productLabel: 'American Express Aeroplan Reserve Card',
        accountType: 'credit_card',
        periodStart: hdr.periodStart,
        periodEnd: hdr.periodEnd,
        accountHolder: hdr.accountHolder || undefined,
      } as PdfStatementHeader,
    };
  },
};
