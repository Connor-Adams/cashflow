/**
 * Parser for Costco gas-station receipts, printed from the Costco.ca
 * "Orders & Purchases" portal as PDF.
 *
 * These are a different document class from warehouse till receipts and share
 * none of their structure:
 *
 *   - headed "Transaction Record", with no "Items Sold:" footer
 *   - the warehouse line is mixed case (` Guelph #1168`), not all caps
 *   - no SUBTOTAL/TAX/TOTAL block; money is `Fuel Sale`, `HST Included =`, `Amt:`
 *   - HST is INCLUDED in the pump price, so subtotal = total - tax
 *   - the card mask uses asterisks (`************3114`), not X's
 *   - the date is `YYYY/MM/DD`, not `MM/DD/YYYY`
 *   - identity comes from `Invoice Number:` + date/time, not whse/trm/trn/opt
 */
import type { PdfLine } from '../types';
import type {
  ExtractedReceiptItem,
  ExtractedReceiptOrder,
  ExtractedReceiptTender,
} from '../../../ai/extractReceiptItems';
import type { ReceiptPdfParseContext, ReceiptPdfParseResult, ReceiptPdfParser } from './types';
import { classifyNetwork } from './costcoTillReceipt';

const TRANSACTION_RECORD = /^Transaction Record$/i;
const FUEL_SALE = /^Fuel Sale\s+\$?([\d,]+\.\d{2})\s*$/i;
/** Mixed-case warehouse line: ` Guelph #1168`. */
const GAS_WAREHOUSE = /^([A-Za-z][A-Za-z .'-]*?)\s*#(\d+)\s*$/;
const PUMP = /^Pump:\s*(\S+)\s*$/i;
const GRADE = /^Grade:\s*(.+?)\s*$/i;
const LITRES = /^Ltrs:\s*([\d,]+\.\d+)\s*$/i;
const PRICE_PER_LITRE = /^Price\/Ltrs:\s*\$?([\d,]+\.\d+)\s*$/i;
const HST_INCLUDED = /^HST Included\s*=\s*\$?([\d,]+\.\d{2})\s*$/i;
const AMOUNT = /^Amt:\s*\$?([\d,]+\.\d{2})\s*$/i;
const DATE_LINE = /^Date:\s*(\d{4})\/(\d{2})\/(\d{2})\s*$/i;
const TIME_LINE = /^Time:\s*(\d{2}):(\d{2})(?::\d{2})?\s*$/i;
const INVOICE = /^Invoice Number:\s*(\d+)\s*$/i;
const GAS_CARD_MASK = /\*{4,}(\d{4})/;
/** Standalone network name line, printed above the masked card. */
const NETWORK_LINE = /^(MASTERCARD|MASTER CARD|VISA|AMEX|AMERICAN EXPRESS|DEBIT|INTERAC|DISCOVER)\s*$/i;

const CENT_TOLERANCE = 0.05;

function toNumber(str: string): number {
  return Number(str.replace(/,/g, ''));
}

function firstMatch(texts: string[], re: RegExp): RegExpMatchArray | null {
  for (const t of texts) {
    const m = t.trim().match(re);
    if (m) return m;
  }
  return null;
}

/** `<whse>-gas-<invoice>-<YYYYMMDD>-<HHMM>` — unique per fill, stable across re-imports. */
export function buildCostcoGasOrderId(
  whse: string,
  invoice: string,
  yyyymmdd: string,
  hhmm: string,
): string {
  return `${whse}-gas-${invoice}-${yyyymmdd}-${hhmm}`;
}

function parseWarehouse(texts: string[]): { name: string | null; number: string | null } {
  // Skip the "Transaction Record" title, which would otherwise match a bare name.
  for (const raw of texts) {
    const t = raw.trim();
    if (TRANSACTION_RECORD.test(t)) continue;
    const m = t.match(GAS_WAREHOUSE);
    if (m) return { name: m[1].trim(), number: m[2] };
  }
  return { name: null, number: null };
}

function buildTender(texts: string[], amount: number | null): ExtractedReceiptTender[] {
  if (amount == null) return [];
  const mask = firstMatch(texts, GAS_CARD_MASK);
  const net = firstMatch(texts, NETWORK_LINE);
  return [{
    paymentLast4: mask ? mask[1] : null,
    network: net ? classifyNetwork(net[1]) : null,
    amount,
  }];
}

function buildFuelItem(texts: string[], preTax: number | null): ExtractedReceiptItem[] {
  if (preTax == null) return [];
  const grade = firstMatch(texts, GRADE)?.[1] ?? null;
  const litres = firstMatch(texts, LITRES)?.[1] ?? null;
  const perLitre = firstMatch(texts, PRICE_PER_LITRE)?.[1] ?? null;

  const volume = [litres ? `${litres} L` : null, perLitre ? `@ $${perLitre}/L` : null]
    .filter(Boolean)
    .join(' ');
  const title = [grade ? `${grade} fuel` : 'Fuel', volume || null].filter(Boolean).join(' — ');

  return [{
    title: title.slice(0, 512),
    // quantity is an INTEGER column; fractional litres live in the title.
    quantity: 1,
    unitPrice: preTax,
    totalPrice: preTax,
    inferredCategory: null,
    vendorItemId: null,
    taxable: true,
  }];
}

function collectWarnings(
  fuelSale: number | null,
  amount: number | null,
  tax: number | null,
  total: number | null,
  subtotal: number | null,
  orderId: string | null,
): string[] {
  const out: string[] = [];
  if (fuelSale != null && amount != null && Math.abs(fuelSale - amount) > CENT_TOLERANCE) {
    out.push(`charged amount (${amount.toFixed(2)}) does not equal Fuel Sale (${fuelSale.toFixed(2)})`);
  }
  if (total == null) out.push('no Fuel Sale or Amt line found');
  if (tax == null) out.push('no "HST Included" line found');
  // subtotal is DERIVED as total - tax, so "subtotal + tax === total" is
  // tautological and can never catch a bad tax line. Sanity-check the derived
  // value independently instead.
  if (subtotal != null && subtotal <= 0) {
    out.push(`tax (${(tax ?? 0).toFixed(2)}) is not less than the charged amount (${(total ?? 0).toFixed(2)})`);
  }
  // HST in Ontario is 13%; a wildly different implied rate means a misparse.
  if (subtotal != null && tax != null && subtotal > 0) {
    const rate = tax / subtotal;
    if (rate < 0.05 || rate > 0.25) {
      out.push(`implied tax rate ${(rate * 100).toFixed(1)}% is outside the plausible range`);
    }
  }
  if (orderId == null) out.push('receipt identity (invoice number / date / time) not found');
  return out;
}

function parse(lines: PdfLine[], ctx: ReceiptPdfParseContext): ReceiptPdfParseResult {
  const texts = lines.map((l) => l.text);

  const fuelSale = firstMatch(texts, FUEL_SALE) ? toNumber(firstMatch(texts, FUEL_SALE)![1]) : null;
  const amtM = firstMatch(texts, AMOUNT);
  const amount = amtM ? toNumber(amtM[1]) : null;
  const taxM = firstMatch(texts, HST_INCLUDED);
  const tax = taxM ? toNumber(taxM[1]) : null;

  // The pump price is tax-inclusive: the charged amount IS the total.
  const total = fuelSale ?? amount;
  const subtotal = total != null && tax != null ? Number((total - tax).toFixed(2)) : null;

  const warehouse = parseWarehouse(texts);
  const dateM = firstMatch(texts, DATE_LINE);
  const timeM = firstMatch(texts, TIME_LINE);
  const invoiceM = firstMatch(texts, INVOICE);

  const orderDate = dateM ? `${dateM[1]}-${dateM[2]}-${dateM[3]}` : null;
  const orderId = dateM && timeM && invoiceM
    ? buildCostcoGasOrderId(
        warehouse.number ?? 'costco',
        invoiceM[1],
        `${dateM[1]}${dateM[2]}${dateM[3]}`,
        `${timeM[1]}${timeM[2]}`,
      )
    : null;

  const tenders = buildTender(texts, total);
  const pump = firstMatch(texts, PUMP)?.[1] ?? null;

  const extracted: ExtractedReceiptOrder = {
    vendor: 'costco',
    vendorName: warehouse.name ? `Costco ${warehouse.name}${warehouse.number ? ` #${warehouse.number}` : ''}` : 'Costco',
    orderDate,
    orderId,
    subtotal,
    tax,
    total,
    currency: ctx.defaultCurrency ?? 'CAD',
    paymentLast4: tenders.length === 1 ? tenders[0].paymentLast4 : null,
    tenders,
    items: buildFuelItem(texts, subtotal),
    notes: pump ? `Pump ${pump}` : null,
  };

  return {
    extracted,
    warnings: collectWarnings(fuelSale, amount, tax, total, subtotal, orderId),
  };
}

export const costcoGasReceiptParser: ReceiptPdfParser = {
  id: 'costco_gas_receipt',
  label: 'Costco gas station receipt',
  // Both signals are required: "Transaction Record" alone appears on other
  // card slips, and a Fuel Sale line alone could belong to another vendor.
  sniff: (lines) => {
    const texts = lines.map((l) => l.text.trim());
    return texts.some((t) => TRANSACTION_RECORD.test(t)) && texts.some((t) => FUEL_SALE.test(t));
  },
  parse,
};
