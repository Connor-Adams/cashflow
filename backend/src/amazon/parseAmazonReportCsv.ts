import { parseCsvRecords } from '../import/csvParse';
import { normalizeAmazonOrder, type NormalizedAmazonOrder, type RawAmazonOrder } from './normalizeAmazonOrder';

type ParseResult = {
  orders: NormalizedAmazonOrder[];
  failedRows: Array<{ rowIndex: number; message: string }>;
  headers: string[];
};

const aliases: Record<string, string[]> = {
  vendorOrderId: ['order id', 'order #', 'order number', 'amazon order id', 'order-id'],
  orderDate: ['order date', 'date', 'purchase date', 'ordered on'],
  shipmentDate: ['shipment date', 'ship date', 'shipped date', 'delivery date'],
  title: ['title', 'item title', 'product name', 'item', 'description'],
  quantity: ['quantity', 'qty', 'original quantity', 'quantity ordered', 'affected item quantity'],
  unitPrice: ['unit price', 'item price', 'price'],
  totalPrice: [
    'item total',
    'item subtotal',
    'line total',
    'total price',
    'shipment item subtotal',
    'transaction amount',
  ],
  subtotal: ['subtotal', 'order subtotal', 'shipment item subtotal'],
  tax: ['tax', 'sales tax', 'gst/hst', 'estimated tax', 'shipment item subtotal tax', 'unit price tax', 'price tax'],
  shipping: ['shipping', 'shipping charge', 'delivery'],
  total: ['total', 'order total', 'grand total', 'charged amount', 'amount', 'total amount', 'transaction amount'],
  currency: ['currency'],
  paymentLast4: [
    'payment last4',
    'payment last 4',
    'card last4',
    'card last 4',
    'last 4',
    'payment method type',
    'payment information',
  ],
};

function canonical(header: string): string {
  return header.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Columns that carry a PER-ROW (per item/shipment) amount in Amazon's data
// export, as opposed to an order-level amount repeated on every row. When
// rows are grouped into one order these must be summed, not first-row-wins
// (e.g. the data export's 'Total Amount' is that row's subtotal + tax).
const PER_ROW_AMOUNT_COLUMNS = new Set(
  [
    'shipment item subtotal',
    'shipment item subtotal tax',
    'unit price tax',
    'price tax',
    'total amount',
    'transaction amount',
    'shipping charge',
  ].map(canonical),
);

type ReadEntry = { value: string; alias: string };

function readEntry(row: Record<string, string>, key: keyof typeof aliases): ReadEntry | null {
  const wanted = new Set(aliases[key].map(canonical));
  for (const [header, value] of Object.entries(row)) {
    const alias = canonical(header);
    if (wanted.has(alias) && String(value || '').trim()) {
      return { value: String(value).trim(), alias };
    }
  }
  return null;
}

function read(row: Record<string, string>, key: keyof typeof aliases): string | null {
  return readEntry(row, key)?.value ?? null;
}

/** Fold a grouped row's amount into the order: sum per-row columns, first-row-wins otherwise. */
function foldAmount(
  current: number | null | undefined,
  next: number | null | undefined,
  alias: string | undefined,
): number | null {
  if (next == null) return current ?? null;
  if (alias != null && PER_ROW_AMOUNT_COLUMNS.has(alias)) {
    return current == null ? next : Math.round((current + next) * 100) / 100;
  }
  return current ?? next;
}

function parseMoney(value: string | null): number | null {
  if (!value) return null;
  // Accounting-style '(12.34)' means a negative (refund/credit).
  const negative = /^\s*\(.*\)\s*$/.test(value);
  const cleaned = value.replace(/[,$]/g, '').replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative && n > 0 ? -n : n;
}

function parseQty(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseLast4(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/\b(\d{4})\b/);
  return match?.[1] ?? null;
}

export function parseAmazonReportCsv(text: string): ParseResult {
  const parsed = parseCsvRecords(text);
  if (!parsed.ok) return { orders: [], failedRows: [{ rowIndex: 0, message: parsed.error }], headers: [] };

  const byKey = new Map<string, RawAmazonOrder>();
  const failedRows: ParseResult['failedRows'] = [];

  parsed.records.forEach((row, index) => {
    const rowIndex = index + 2;
    const title = read(row, 'title');
    const totalEntry = readEntry(row, 'total');
    const total = parseMoney(totalEntry?.value ?? null);
    const totalPrice = parseMoney(read(row, 'totalPrice'));
    const unitPrice = parseMoney(read(row, 'unitPrice'));
    if (!title) {
      failedRows.push({ rowIndex, message: 'Missing item title' });
      return;
    }
    const vendorOrderId = read(row, 'vendorOrderId');
    const orderDate = read(row, 'orderDate');
    const shipmentDate = read(row, 'shipmentDate');
    const currency = read(row, 'currency') || 'CAD';
    const paymentLast4 = parseLast4(read(row, 'paymentLast4'));
    const subtotalEntry = readEntry(row, 'subtotal');
    const taxEntry = readEntry(row, 'tax');
    const shippingEntry = readEntry(row, 'shipping');
    const rawOrder: RawAmazonOrder = {
      vendorOrderId,
      orderDate,
      shipmentDate,
      subtotal: parseMoney(subtotalEntry?.value ?? null),
      tax: parseMoney(taxEntry?.value ?? null),
      shipping: parseMoney(shippingEntry?.value ?? null),
      total,
      currency,
      paymentLast4,
      source: 'amazon_report',
      rawPayload: row,
      items: [
        {
          title,
          quantity: parseQty(read(row, 'quantity')),
          unitPrice,
          totalPrice,
          rawPayload: row,
        },
      ],
    };
    const normalizedRow = normalizeAmazonOrder(rawOrder);
    if (!normalizedRow.orderDate && !normalizedRow.shipmentDate) {
      failedRows.push({ rowIndex, message: 'Missing order or shipment date' });
      return;
    }
    const key = vendorOrderId?.trim()
      ? `order:${vendorOrderId.trim()}`
      : [
          'fallback',
          normalizedRow.orderDate || normalizedRow.shipmentDate,
          total == null ? '' : Math.round(total * 100),
          currency.toUpperCase(),
          paymentLast4 || '',
        ].join(':');
    const existing = byKey.get(key);
    if (existing) {
      existing.items.push(rawOrder.items[0]);
      existing.subtotal = foldAmount(existing.subtotal, rawOrder.subtotal, subtotalEntry?.alias);
      existing.tax = foldAmount(existing.tax, rawOrder.tax, taxEntry?.alias);
      existing.shipping = foldAmount(existing.shipping, rawOrder.shipping, shippingEntry?.alias);
      existing.total = foldAmount(existing.total, rawOrder.total, totalEntry?.alias);
    } else {
      byKey.set(key, rawOrder);
    }
  });

  return {
    orders: Array.from(byKey.values()).map(normalizeAmazonOrder),
    failedRows,
    headers: parsed.headers,
  };
}
