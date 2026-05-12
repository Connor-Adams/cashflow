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
  quantity: ['quantity', 'qty'],
  unitPrice: ['unit price', 'item price', 'price'],
  totalPrice: ['item total', 'item subtotal', 'line total', 'total price'],
  subtotal: ['subtotal', 'order subtotal'],
  tax: ['tax', 'sales tax', 'gst/hst', 'estimated tax'],
  shipping: ['shipping', 'shipping charge', 'delivery'],
  total: ['total', 'order total', 'grand total', 'charged amount', 'amount'],
  currency: ['currency'],
  paymentLast4: ['payment last4', 'payment last 4', 'card last4', 'card last 4', 'last 4'],
};

function canonical(header: string): string {
  return header.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function read(row: Record<string, string>, key: keyof typeof aliases): string | null {
  const wanted = new Set(aliases[key].map(canonical));
  for (const [header, value] of Object.entries(row)) {
    if (wanted.has(canonical(header)) && String(value || '').trim()) return String(value).trim();
  }
  return null;
}

function parseMoney(value: string | null): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[,$]/g, '').replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseQty(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseAmazonReportCsv(text: string): ParseResult {
  const parsed = parseCsvRecords(text);
  if (!parsed.ok) return { orders: [], failedRows: [{ rowIndex: 0, message: parsed.error }], headers: [] };

  const byKey = new Map<string, RawAmazonOrder>();
  const failedRows: ParseResult['failedRows'] = [];

  parsed.records.forEach((row, index) => {
    const rowIndex = index + 2;
    const title = read(row, 'title');
    const total = parseMoney(read(row, 'total'));
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
    const paymentLast4 = read(row, 'paymentLast4');
    const rawOrder: RawAmazonOrder = {
      vendorOrderId,
      orderDate,
      shipmentDate,
      subtotal: parseMoney(read(row, 'subtotal')),
      tax: parseMoney(read(row, 'tax')),
      shipping: parseMoney(read(row, 'shipping')),
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
      existing.subtotal ??= rawOrder.subtotal;
      existing.tax ??= rawOrder.tax;
      existing.shipping ??= rawOrder.shipping;
      existing.total ??= rawOrder.total;
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
