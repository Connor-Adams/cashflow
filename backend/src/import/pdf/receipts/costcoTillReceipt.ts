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

function classifyNetwork(name: string): string | null {
  const n = name.toUpperCase();
  if (n.includes('COSTCO') && n.includes('MASTERCARD')) return 'costco-mastercard';
  if (n.includes('MASTER CARD') || n.includes('MASTERCARD')) return 'mastercard';
  if (n.includes('VISA')) return 'visa';
  if (n.includes('AMERICAN EXPRESS') || n.includes('AMEX')) return 'amex';
  if (n.includes('DEBIT')) return 'debit';
  if (n.includes('CASH')) return 'cash';
  return null;
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

/**
 * Decide whether `line` is a plausible fragment of a wrapped item name.
 * Structural lines (totals, tender rows, header) must NOT be pulled into a name.
 */
function looksLikeNameFragment(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (ITEM_LINE.test(t)) return false;
  if (SUBTOTAL_LINE.test(t)) return false;
  if (TAX_LINE.test(t)) return false;
  if (TOTAL_LINE.test(t)) return false;
  if (TENDER_ROW.test(t)) return false;
  if (CARD_MASK.test(t)) return false;
  if (FOOTER_DATE_LINE.test(t)) return false;
  if (WAREHOUSE_HEADER.test(t)) return false;
  if (/^Member$/i.test(t)) return false;
  if (/^\d{10,}$/.test(t)) return false; // member number, barcode
  if (/^\d{1,3}$/.test(t)) return false; // bare small numbers (item-id leftovers)
  if (/Items Sold:/i.test(t)) return false;
  if (/INSTANT SAVINGS/i.test(t)) return false;
  if (/\(A\) HST/i.test(t)) return false;
  if (/TOTAL TAX/i.test(t)) return false;
  if (/^CHANGE\b/.test(t)) return false;
  if (/^AMOUNT:/i.test(t)) return false;
  if (/^APPROVED/i.test(t)) return false;
  if (/^CHIP$/i.test(t)) return false;
  if (/^read$/i.test(t)) return false;
  if (/^P\d\b/.test(t)) return false;
  if (/^whse:/i.test(t)) return false;
  if (/H=HST|GST\/HST|QST/i.test(t)) return false;
  if (/Thank You|Please Come Again/i.test(t)) return false;
  return true;
}

function resolveWrappedName(texts: string[], rowIndex: number, midName: string): string {
  if (midName) return midName;
  const parts: string[] = [];
  const prev = rowIndex > 0 ? texts[rowIndex - 1].trim() : '';
  const next = rowIndex + 1 < texts.length ? texts[rowIndex + 1].trim() : '';
  if (looksLikeNameFragment(prev)) parts.push(prev);
  if (looksLikeNameFragment(next)) parts.push(next);
  return parts.join(' ');
}

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

function parse(lines: PdfLine[], ctx: ReceiptPdfParseContext): ReceiptPdfParseResult {
  const texts = lines.map((l) => l.text);
  const warnings: string[] = [];

  // Header — warehouse name + number
  const headerIdx = findIndex(texts, (t) => WAREHOUSE_HEADER.test(t));
  let warehouseName: string | null = null;
  let warehouseNumber: string | null = null;
  if (headerIdx >= 0) {
    const m = texts[headerIdx].trim().match(WAREHOUSE_HEADER)!;
    warehouseName = m[1];
    warehouseNumber = m[2];
  } else {
    warnings.push('warehouse header not found');
  }

  // Footer — date/time/whse/trm/trn/opt
  const footer = findCostcoFooter(texts);
  if (!footer) {
    warnings.push('receipt footer (date/time/whse/trm/trn/opt) not found');
  }

  // Totals
  const totals = findTotals(texts);
  if (totals.total == null) warnings.push('TOTAL line not found');
  if (totals.subtotal == null) warnings.push('SUBTOTAL line not found');

  // Items
  const itemStart = findItemsStart(texts);
  const itemEnd = totals.subtotalIdx >= 0 ? totals.subtotalIdx : texts.length;
  const items = itemStart >= 0 ? parseItems(texts, itemStart, itemEnd) : [];

  // Reconcile items → subtotal
  const itemsSum = items.reduce((acc, it) => acc + (it.totalPrice ?? 0), 0);
  if (totals.subtotal != null && Math.abs(itemsSum - totals.subtotal) > CENT_TOLERANCE) {
    warnings.push(
      `items sum (${itemsSum.toFixed(2)}) does not equal SUBTOTAL (${totals.subtotal.toFixed(2)})`,
    );
  }

  // Tenders
  const { cards, tenderRows } = parseCostcoTenders(texts, totals.totalIdx);
  const tenders = buildTenders(cards, tenderRows);

  // Reconcile tenders → total
  if (tenders.length > 0 && totals.total != null) {
    const tendersSum = tenders.reduce((a, t) => a + t.amount, 0);
    if (!near(tendersSum, totals.total)) {
      warnings.push(
        `tenders sum (${tendersSum.toFixed(2)}) does not equal TOTAL (${totals.total.toFixed(2)})`,
      );
    }
  }

  // Reconcile subtotal + tax → total
  if (totals.subtotal != null && totals.tax != null && totals.total != null) {
    if (!near(totals.subtotal + totals.tax, totals.total)) {
      warnings.push(
        `subtotal + tax (${(totals.subtotal + totals.tax).toFixed(2)}) does not equal TOTAL (${totals.total.toFixed(2)})`,
      );
    }
  }

  const orderId = footer
    ? buildCostcoOrderId(footer.whse, footer.trm, footer.trn, footer.opt, footer.orderDate.replaceAll('-', ''), footer.hhmm)
    : null;

  // For single-tender receipts, surface paymentLast4 directly (existing matcher fallback).
  // For split-tender receipts, leave paymentLast4 null and rely on the tenders array.
  const singleLast4 = tenders.length === 1 ? tenders[0].paymentLast4 : null;

  const vendorName = warehouseName
    ? `Costco ${warehouseName.replace(/\s+/g, ' ').trim()}${warehouseNumber ? ` #${warehouseNumber}` : ''}`
    : 'Costco';

  const extracted: ExtractedReceiptOrder = {
    vendor: 'costco',
    vendorName,
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
