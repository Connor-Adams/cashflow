/**
 * Parser for Costco warehouse till receipts (printed from the Costco.ca
 * "Orders & Purchases" portal as PDF). Handles single-tender and split-tender
 * receipts, instant-savings (TPD) lines, and bottle deposits.
 */
import type { PdfLine } from '../types';
import type {
  ExtractedReceiptItem,
  ExtractedReceiptOrder,
  ExtractedReceiptTender,
} from '../../../ai/extractReceiptItems';
import type { ReceiptPdfParseContext, ReceiptPdfParseResult, ReceiptPdfParser } from './types';

const WAREHOUSE_HEADER = /^\s*([A-Z][A-Z .'-]+?)\s*#(\d+)\s*$/;
const ITEMS_SOLD_FOOTER = /Items Sold:\s*\d+/i;
/**
 * Data line: ` <ITEM_ID>   <NAME?>   <PRICE>[-]   [Y|N]?`
 * NAME captured non-greedily; may be empty when the item name wraps onto
 * adjacent lines (the printed receipt sometimes splits a long name across
 * three lines, with the numeric data on the middle line).
 */
const ITEM_LINE = /^(\d+)\s+(.*?)\s+(-?[\d,]+\.\d+)(-?)\s*([YN])?\s*$/;
const SUBTOTAL_LINE = /^SUBTOTAL\s+([\d,]+\.\d+)\s*$/;
const TAX_LINE = /^TAX\s+([\d,]+\.\d+)\s*$/;
const TOTAL_LINE = /^\*+\s*TOTAL\s+([\d,]+\.\d+)\s*$/;
const CARD_MASK = /X{4,}(\d{4})/;
const TENDER_ROW = /^([A-Z][A-Z &]+?)\s+([\d,]+\.\d{2})\s*$/;
const FOOTER_DATE_LINE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

const TENDER_NAME_BLACKLIST = new Set([
  'AMOUNT',
  'APPROVED PURCHASE',
  'APPROVED -PURCHASE',
  'CHANGE',
  'SUBTOTAL',
  'TAX',
  'TOTAL',
  'TOTAL TAX',
  'INSTANT SAVINGS',
  'TOTAL NUMBER OF ITEMS SOLD',
]);

function toNumber(str: string): number {
  return Number(str.replace(/,/g, ''));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Build an order id from the printed footer: `<whse>-<trm>-<trn>-<opt>-<YYYYMMDD>-<HHMM>`. */
export function buildCostcoOrderId(
  whse: string,
  trm: string,
  trn: string,
  opt: string,
  yyyymmdd: string,
  hhmm: string,
): string {
  return `${whse}-${trm}-${trn}-${opt}-${yyyymmdd}-${hhmm}`;
}

type Footer = {
  orderDate: string; // YYYY-MM-DD
  hhmm: string;      // HHMM (no colon)
  whse: string;
  trm: string;
  trn: string;
  opt: string;
};

export function findCostcoFooter(texts: string[]): Footer | null {
  for (const raw of texts) {
    const m = raw.trim().match(FOOTER_DATE_LINE);
    if (!m) continue;
    const [, mm, dd, yyyy, hh, mi, whse, trm, trn, opt] = m;
    return {
      orderDate: `${yyyy}-${pad2(Number(mm))}-${pad2(Number(dd))}`,
      hhmm: `${pad2(Number(hh))}${mi}`,
      whse,
      trm,
      trn,
      opt,
    };
  }
  return null;
}

const NETWORK_MATCHERS: Array<{ test: (n: string) => boolean; name: string }> = [
  { test: (n) => n.includes('COSTCO') && n.includes('MASTERCARD'), name: 'costco-mastercard' },
  { test: (n) => n.includes('MASTER CARD') || n.includes('MASTERCARD'), name: 'mastercard' },
  { test: (n) => n.includes('VISA'), name: 'visa' },
  { test: (n) => n.includes('AMERICAN EXPRESS') || n.includes('AMEX'), name: 'amex' },
  { test: (n) => n.includes('DEBIT'), name: 'debit' },
  { test: (n) => n.includes('CASH'), name: 'cash' },
];

export function classifyNetwork(name: string): string | null {
  const upper = name.toUpperCase();
  return NETWORK_MATCHERS.find((m) => m.test(upper))?.name ?? null;
}

type ParsedItemRow = {
  index: number; // line index for wrap lookup
  itemId: string;
  midName: string;
  priceText: string;
  neg: boolean;
  taxFlag: 'Y' | 'N' | null;
};

function parseItemRow(line: string, index: number): ParsedItemRow | null {
  const m = line.match(ITEM_LINE);
  if (!m) return null;
  const [, itemId, mid, priceText, neg, taxFlag] = m;
  return {
    index,
    itemId,
    midName: mid.trim(),
    priceText,
    neg: neg === '-',
    taxFlag: (taxFlag as 'Y' | 'N' | undefined) ?? null,
  };
}

/** Patterns that mark a line as structural (totals, tender, header, footer chrome). */
const STRUCTURAL_LINE_PATTERNS: RegExp[] = [
  ITEM_LINE,
  SUBTOTAL_LINE,
  TAX_LINE,
  TOTAL_LINE,
  TENDER_ROW,
  CARD_MASK,
  FOOTER_DATE_LINE,
  WAREHOUSE_HEADER,
  /^Member$/i,
  /^\d{10,}$/, // member number, barcode
  /^\d{1,3}$/, // bare small numbers (item-id leftovers)
  /Items Sold:/i,
  /INSTANT SAVINGS/i,
  /\(A\) HST/i,
  /TOTAL TAX/i,
  /^CHANGE\b/,
  /^AMOUNT:/i,
  /^APPROVED/i,
  /^CHIP$/i,
  /^read$/i,
  /^P\d\b/,
  /^whse:/i,
  /H=HST|GST\/HST|QST/i,
  /Thank You|Please Come Again/i,
];

/**
 * Decide whether `line` is a plausible fragment of a wrapped item name.
 * Structural lines (totals, tender rows, header) must NOT be pulled into a name.
 */
export function looksLikeNameFragment(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return !STRUCTURAL_LINE_PATTERNS.some((re) => re.test(t));
}

// Exercised by R1 (FRANKS/SAUCE) and R2 (DEPOSIT/VL) parser tests.
// fallow-ignore-next-line complexity
function resolveWrappedName(texts: string[], rowIndex: number, midName: string): string {
  if (midName) return midName;
  const parts: string[] = [];
  const prev = rowIndex > 0 ? texts[rowIndex - 1].trim() : '';
  const next = rowIndex + 1 < texts.length ? texts[rowIndex + 1].trim() : '';
  if (looksLikeNameFragment(prev)) parts.push(prev);
  if (looksLikeNameFragment(next)) parts.push(next);
  return parts.join(' ');
}

// Linear item-row walk with wrap detection; covered by R1/R2 parser tests.
// fallow-ignore-next-line complexity
function parseItems(texts: string[], startIdx: number, endIdx: number): ExtractedReceiptItem[] {
  const items: ExtractedReceiptItem[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const trimmed = texts[i].trim();
    const row = parseItemRow(trimmed, i);
    if (!row) continue;
    const name = resolveWrappedName(texts, i, row.midName);
    let price = toNumber(row.priceText);
    if (row.neg) price = -price;
    const title = name || row.itemId;
    items.push({
      title: title.slice(0, 512),
      quantity: 1,
      unitPrice: price,
      totalPrice: price,
      inferredCategory: null,
      vendorItemId: row.itemId,
      taxable: row.taxFlag === 'Y' ? true : row.taxFlag === 'N' ? false : null,
    });
  }
  return items;
}

function findIndex(texts: string[], pred: (t: string) => boolean): number {
  for (let i = 0; i < texts.length; i++) {
    if (pred(texts[i].trim())) return i;
  }
  return -1;
}

type TotalsBlock = {
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  subtotalIdx: number;
  totalIdx: number;
};

// One-pass scanner for SUBTOTAL/TAX/TOTAL; covered by R1/R2 parser tests.
// fallow-ignore-next-line complexity
function findTotals(texts: string[]): TotalsBlock {
  let subtotal: number | null = null;
  let tax: number | null = null;
  let total: number | null = null;
  let subtotalIdx = -1;
  let totalIdx = -1;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i].trim();
    const ms = t.match(SUBTOTAL_LINE);
    if (ms && subtotal == null) {
      subtotal = toNumber(ms[1]);
      subtotalIdx = i;
      continue;
    }
    const mt = t.match(TAX_LINE);
    if (mt && tax == null) {
      tax = toNumber(mt[1]);
      continue;
    }
    const mtot = t.match(TOTAL_LINE);
    if (mtot && total == null) {
      total = toNumber(mtot[1]);
      totalIdx = i;
      continue;
    }
  }
  return { subtotal, tax, total, subtotalIdx, totalIdx };
}

function findItemsStart(texts: string[]): number {
  // First line that looks like a parseable item row.
  for (let i = 0; i < texts.length; i++) {
    if (parseItemRow(texts[i].trim(), i)) return i;
  }
  return -1;
}

// Tender-block scanner with blacklist guard; covered by parseCostcoTenders + R2 tests.
// fallow-ignore-next-line complexity
export function parseCostcoTenders(texts: string[], totalIdx: number): {
  cards: string[];
  tenderRows: { name: string; amount: number; index: number }[];
} {
  const cards: string[] = [];
  const tenderRows: { name: string; amount: number; index: number }[] = [];

  const start = totalIdx >= 0 ? totalIdx + 1 : 0;
  for (let i = start; i < texts.length; i++) {
    const t = texts[i].trim();

    const c = t.match(CARD_MASK);
    if (c) cards.push(c[1]);

    // A "MASTER CARD   1,863.72" style row.
    const m = t.match(TENDER_ROW);
    if (!m) continue;
    const name = m[1].trim().toUpperCase();
    if (TENDER_NAME_BLACKLIST.has(name)) continue;
    // Skip the "(A) HST   97.23" pseudo-row (caught by SUBTOTAL_LINE/TAX_LINE earlier
    // but the leading "(A) " prevents that match; explicit guard here).
    if (t.startsWith('(A)')) continue;
    tenderRows.push({ name, amount: toNumber(m[2]), index: i });
  }

  return { cards, tenderRows };
}

function buildTenders(cards: string[], tenderRows: { name: string; amount: number }[]): ExtractedReceiptTender[] {
  return tenderRows.map((row, idx) => ({
    paymentLast4: cards[idx] ?? null,
    network: classifyNetwork(row.name),
    amount: row.amount,
  }));
}

const CENT_TOLERANCE = 0.05;

function near(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= CENT_TOLERANCE;
}

type WarehouseHeader = { name: string | null; number: string | null };

function parseWarehouseHeader(texts: string[]): WarehouseHeader {
  const idx = findIndex(texts, (t) => WAREHOUSE_HEADER.test(t));
  if (idx < 0) return { name: null, number: null };
  const m = texts[idx].trim().match(WAREHOUSE_HEADER)!;
  return { name: m[1], number: m[2] };
}

function buildVendorName(header: WarehouseHeader): string {
  if (!header.name) return 'Costco';
  const cleaned = header.name.replace(/\s+/g, ' ').trim();
  const numSuffix = header.number ? ` #${header.number}` : '';
  return `Costco ${cleaned}${numSuffix}`;
}

// Linear missing-field check.
// fallow-ignore-next-line complexity
function collectMissingHeaderWarnings(
  header: WarehouseHeader,
  footer: Footer | null,
  totals: TotalsBlock,
): string[] {
  const out: string[] = [];
  if (!header.name) out.push('warehouse header not found');
  if (!footer) out.push('receipt footer (date/time/whse/trm/trn/opt) not found');
  if (totals.total == null) out.push('TOTAL line not found');
  if (totals.subtotal == null) out.push('SUBTOTAL line not found');
  return out;
}

function checkItemsSum(items: ExtractedReceiptItem[], subtotal: number | null): string | null {
  if (subtotal == null) return null;
  const sum = items.reduce((acc, it) => acc + (it.totalPrice ?? 0), 0);
  if (Math.abs(sum - subtotal) <= CENT_TOLERANCE) return null;
  return `items sum (${sum.toFixed(2)}) does not equal SUBTOTAL (${subtotal.toFixed(2)})`;
}

function checkTendersSum(tenders: ExtractedReceiptTender[], total: number | null): string | null {
  if (tenders.length === 0 || total == null) return null;
  const sum = tenders.reduce((a, t) => a + t.amount, 0);
  if (near(sum, total)) return null;
  return `tenders sum (${sum.toFixed(2)}) does not equal TOTAL (${total.toFixed(2)})`;
}

// Null-guard chain.
// fallow-ignore-next-line complexity
function checkSubtotalPlusTax(totals: TotalsBlock): string | null {
  if (totals.subtotal == null || totals.tax == null || totals.total == null) return null;
  if (near(totals.subtotal + totals.tax, totals.total)) return null;
  return `subtotal + tax (${(totals.subtotal + totals.tax).toFixed(2)}) does not equal TOTAL (${totals.total.toFixed(2)})`;
}

// Composes section parsers + validation; covered by R1/R2 parser tests.
// fallow-ignore-next-line complexity
function parse(lines: PdfLine[], ctx: ReceiptPdfParseContext): ReceiptPdfParseResult {
  const texts = lines.map((l) => l.text);

  const header = parseWarehouseHeader(texts);
  const footer = findCostcoFooter(texts);
  const totals = findTotals(texts);

  const itemStart = findItemsStart(texts);
  const itemEnd = totals.subtotalIdx >= 0 ? totals.subtotalIdx : texts.length;
  const items = itemStart >= 0 ? parseItems(texts, itemStart, itemEnd) : [];

  const { cards, tenderRows } = parseCostcoTenders(texts, totals.totalIdx);
  const tenders = buildTenders(cards, tenderRows);

  const warnings = [
    ...collectMissingHeaderWarnings(header, footer, totals),
    checkItemsSum(items, totals.subtotal),
    checkTendersSum(tenders, totals.total),
    checkSubtotalPlusTax(totals),
  ].filter((w): w is string => w != null);

  const orderId = footer
    ? buildCostcoOrderId(footer.whse, footer.trm, footer.trn, footer.opt, footer.orderDate.replaceAll('-', ''), footer.hhmm)
    : null;

  // For single-tender receipts, surface paymentLast4 directly (existing matcher fallback).
  // For split-tender receipts, leave paymentLast4 null and rely on the tenders array.
  const singleLast4 = tenders.length === 1 ? tenders[0].paymentLast4 : null;

  const extracted: ExtractedReceiptOrder = {
    vendor: 'costco',
    vendorName: buildVendorName(header),
    orderDate: footer?.orderDate ?? null,
    orderId,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    currency: ctx.defaultCurrency || 'CAD',
    paymentLast4: singleLast4,
    tenders,
    items,
    notes: null,
  };

  return { extracted, warnings };
}

function sniff(lines: PdfLine[]): boolean {
  const texts = lines.map((l) => l.text);
  const hasWarehouseHeader = texts.some((t) => WAREHOUSE_HEADER.test(t.trim()));
  const hasItemsSold = texts.some((t) => ITEMS_SOLD_FOOTER.test(t));
  return hasWarehouseHeader && hasItemsSold;
}

export const costcoTillReceiptParser: ReceiptPdfParser = {
  id: 'costco_till_receipt',
  label: 'Costco warehouse till receipt',
  sniff,
  parse,
};
