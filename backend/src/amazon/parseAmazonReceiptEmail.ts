import { normalizeAmazonOrder, type NormalizedAmazonOrder } from './normalizeAmazonOrder';

function findMoney(label: string, text: string): number | null {
  const re = new RegExp(`${label}[^\\d$-]*\\$?([\\d,]+(?:\\.\\d{2})?)`, 'i');
  const match = text.match(re);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

export function parseAmazonReceiptEmail(text: string): NormalizedAmazonOrder | null {
  const orderId = text.match(/order\s*(?:#|id|number)?\s*[:#]?\s*([0-9]{3}-[0-9]{7}-[0-9]{7})/i)?.[1] ?? null;
  const total = findMoney('total', text);
  const date = text.match(/(?:ordered|order date|placed on)\s*:?\s*([A-Za-z0-9, /-]+)/i)?.[1]?.trim() ?? null;
  const last4 = text.match(/(?:ending in|last 4)\s*(\d{4})/i)?.[1] ?? null;
  const title =
    text.match(/(?:item|product)\s*:?\s*(.+)$/im)?.[1]?.trim() ||
    text.match(/(?:shipped|arriving).*\n(.+)$/im)?.[1]?.trim() ||
    null;
  if (!orderId && !total && !title) return null;
  return normalizeAmazonOrder({
    vendorOrderId: orderId,
    orderDate: date,
    shipmentDate: null,
    total,
    currency: 'CAD',
    paymentLast4: last4,
    source: 'email',
    rawPayload: { text },
    items: [{ title: title || 'Amazon purchase', totalPrice: total }],
  });
}
