import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { MONTHS_SHORT, toIso, monthDayToIso, type Period } from './dateHelpers';

const SNIFF_RE = /American Express.*Card\b/;

const PRODUCT_RE = /^\s*(American Express\S*\s+.+?Card)\b/;

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
  /^American Express/,
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

export type AmexHeader = {
  accountSuffix: string;
  periodStart: string;
  periodEnd: string;
  accountHolder: string;
  productLabel: string;
};

function detectProductLabel(lines: PdfLine[]): string {
  for (const l of lines.filter((l) => l.page === 1)) {
    const m = PRODUCT_RE.exec(l.text.trim());
    if (m) return m[1].replace(/[®™*]/g, '').replace(/\s+/g, ' ').trim();
  }
  return 'American Express Card';
}

export function parseAmexHeader(lines: PdfLine[]): AmexHeader {
  let accountHolder = '';
  const productLabel = detectProductLabel(lines);

  for (const l of lines.filter((l) => l.page === 1)) {
    const m = HEADER_RE.exec(l.text);
    if (!m) continue;
    const accountSuffix = m[1].replace(/\s+/g, '').slice(-1) + m[2];
    const periodStart = parseHeaderDate(m[3]);
    const periodEnd = parseHeaderDate(m[4]);

    const holderMatch = /^\s*(.+?)\s{3,}XXXX/.exec(l.text);
    if (holderMatch) accountHolder = holderMatch[1].trim();

    return { accountSuffix, periodStart, periodEnd, accountHolder, productLabel };
  }
  throw new Error('Amex header: could not find account/period line');
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
  transDate: string;
  postDate: string;
  merchantRaw: string;
  amount: number;
  sourceReference: string | null;
  fxCurrency: string | null;
  fxAmount: number | null;
  fxRate: number | null;
};

export const amexParser: PdfParser = {
  id: 'amex',
  label: 'American Express',
  sniff: (lines) => lines.some((l) => SNIFF_RE.test(l.text)),

  parse: (lines, ctx) => {
    const hdr = parseAmexHeader(lines);
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
      // Negate: Amex PDF positive = charge, negative = credit/payment.
      // Cashflow credit-card convention: positive = money in, negative = money out.
      const amount = -pending.amount;

      let merchantRaw = pending.merchantRaw;
      if (pending.fxCurrency && pending.fxAmount != null && pending.fxRate != null) {
        merchantRaw += ` [${pending.fxCurrency} ${pending.fxAmount.toFixed(2)} @ ${pending.fxRate}]`;
      }

      txnSections.push(pending.section);
      transactions.push({
        date: pending.postDate,
        merchantRaw,
        merchantClean: normalizeMerchant(pending.merchantRaw),
        amount,
        currency: ctx.defaultCurrency,
        sourceReference: pending.sourceReference,
      });
      pending = null;
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
        if (pending && pending.amount === 0) {
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
            transDate,
            postDate,
            merchantRaw: rowMatch[3].trim(),
            amount: 0,
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
        productLabel: hdr.productLabel,
        accountType: 'credit_card',
        periodStart: hdr.periodStart,
        periodEnd: hdr.periodEnd,
        accountHolder: hdr.accountHolder || undefined,
      } as PdfStatementHeader,
    };
  },
};
