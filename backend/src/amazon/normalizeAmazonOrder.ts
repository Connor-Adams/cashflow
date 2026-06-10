import crypto from 'crypto';
import { categorizeAmazonItem } from './categories';

export type AmazonOrderSource =
  | 'amazon_report'
  | 'email'
  | 'forwarded_email'
  | 'pdf'
  | 'manual';

export type RawAmazonOrderItem = {
  title: string;
  quantity?: number | null;
  unitPrice?: number | null;
  totalPrice?: number | null;
  inferredCategory?: string | null;
  businessUsePercent?: number | null;
  confidence?: number | null;
  rawPayload?: unknown;
};

export type RawAmazonOrder = {
  vendorOrderId?: string | null;
  orderDate?: string | null;
  shipmentDate?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  shipping?: number | null;
  total?: number | null;
  currency?: string | null;
  paymentLast4?: string | null;
  source: AmazonOrderSource;
  rawPayload?: unknown;
  items: RawAmazonOrderItem[];
};

export type NormalizedAmazonOrderItem = Required<
  Pick<RawAmazonOrderItem, 'title' | 'quantity'>
> &
  Omit<RawAmazonOrderItem, 'title' | 'quantity'>;

export type NormalizedAmazonOrder = Omit<RawAmazonOrder, 'items' | 'currency'> & {
  vendor: 'amazon';
  currency: string;
  dedupeKey: string;
  items: NormalizedAmazonOrderItem[];
};

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const m = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!m) return null;
  const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  let month = Number(m[1]);
  let day = Number(m[2]);
  // Ambiguous between MM/DD and DD/MM: keep the MM/DD assumption unless the
  // first component cannot be a month (Amazon.ca exports are often day-first).
  if (month > 12 && day <= 12) [month, day] = [day, month];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject impossible calendar dates (e.g. Feb 31) instead of emitting them.
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function cents(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '';
  return Math.round(value * 100).toString();
}

export function amazonOrderDedupeKey(order: {
  vendorOrderId?: string | null;
  orderDate?: string | null;
  shipmentDate?: string | null;
  total?: number | null;
  items: Array<{ title: string }>;
}): string {
  if (order.vendorOrderId?.trim()) return `amazon:order:${order.vendorOrderId.trim()}`;
  const date = order.orderDate || order.shipmentDate || '';
  const titleHash = crypto
    .createHash('sha256')
    .update(order.items.map((item) => normalizeTitle(item.title)).sort().join('|'))
    .digest('hex')
    .slice(0, 24);
  return `amazon:fallback:${date}:${cents(order.total)}:${titleHash}`;
}

export function normalizeAmazonOrder(raw: RawAmazonOrder): NormalizedAmazonOrder {
  const orderDate = normalizeDate(raw.orderDate);
  const shipmentDate = normalizeDate(raw.shipmentDate);
  const items = raw.items
    .filter((item) => item.title?.trim())
    .map((item) => {
      const quantity = Math.max(1, Math.round(Number(item.quantity || 1)));
      const totalPrice =
        item.totalPrice ?? (item.unitPrice == null ? null : Number(item.unitPrice) * quantity);
      return {
        title: item.title.trim(),
        quantity,
        unitPrice: item.unitPrice ?? null,
        totalPrice,
        inferredCategory: item.inferredCategory ?? categorizeAmazonItem(item.title),
        businessUsePercent: item.businessUsePercent ?? null,
        confidence: item.confidence ?? null,
        rawPayload: item.rawPayload ?? null,
      };
    });
  const normalized = {
    vendor: 'amazon' as const,
    vendorOrderId: raw.vendorOrderId?.trim() || null,
    orderDate,
    shipmentDate,
    subtotal: raw.subtotal ?? null,
    tax: raw.tax ?? null,
    shipping: raw.shipping ?? null,
    total: raw.total ?? null,
    currency: (raw.currency || 'CAD').trim().toUpperCase(),
    paymentLast4: raw.paymentLast4?.trim() || null,
    source: raw.source,
    rawPayload: raw.rawPayload ?? null,
    items,
  };
  return { ...normalized, dedupeKey: amazonOrderDedupeKey(normalized) };
}
