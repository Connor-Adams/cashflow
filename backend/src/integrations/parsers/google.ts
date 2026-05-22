/**
 * Google receipt-email parser (Google Play / Google Pay / YouTube Premium / etc).
 *
 * Google receipts vary by service:
 *   - Google Play: clear "Order number" + per-item lines + total
 *   - Google Pay: less structured, more transactional
 *   - YouTube Premium: recurring subscription line + monthly total
 */
import type { ExtractedReceiptOrder, ExtractedReceiptItem } from '../../ai/extractReceiptItems';

const ORDER_ID_RE = /\b(?:Order\s*(?:number|ID)|Receipt\s*#)\s*[:\-]?\s*([A-Z0-9.\-]{6,40})/i;
const TOTAL_RE = /\b(?:Total|Grand\s*total|Amount\s*charged)\b\s*[:\-]?\s*\$?\s*([0-9]+(?:[.,][0-9]{2}))/i;
const DATE_RE = /\b(?:Date|Order\s*date|Purchase\s*date|Transaction\s*date)\b\s*[:\-]?\s*([A-Za-z]{3,9}\s+[0-9]{1,2},?\s+[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i;
const ITEM_LINE_RE = /^(.{2,120}?)\s+\$\s*([0-9]+(?:\.[0-9]{2})?)\s*$/;
const LAST4_RE = /(?:ending\s*in|·{2,}|x{2,})\s*(\d{4})/i;

function normalizeDate(raw: string): string | null {
  const d = new Date(raw.trim());
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function categoriseGoogleItem(title: string): string | null {
  const t = title.toLowerCase();
  if (/youtube\s*premium|youtube\s*music/.test(t)) return 'Subscriptions';
  if (/google\s*one|drive\s*storage|gb|tb/.test(t)) return 'Subscriptions';
  if (/google\s*play\s*pass/.test(t)) return 'Subscriptions';
  if (/in[\s-]?app\s*purchase|app\s*purchase/.test(t)) return 'Apps';
  return null;
}

export function parseGoogleReceipt(body: string): ExtractedReceiptOrder | null {
  if (!/google|youtube|google\s*play|google\s*pay/i.test(body)) return null;

  const orderId = body.match(ORDER_ID_RE)?.[1] ?? null;
  const totalMatch = body.match(TOTAL_RE);
  const total = totalMatch ? Number(totalMatch[1].replace(',', '.')) : null;
  const dateMatch = body.match(DATE_RE);
  const orderDate = dateMatch ? normalizeDate(dateMatch[1]) : null;
  const last4 = body.match(LAST4_RE)?.[1] ?? null;

  const items: ExtractedReceiptItem[] = [];
  for (const lineRaw of body.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (/^\s*(total|subtotal|tax|amount\s*charged|grand\s*total)\b/i.test(line)) continue;
    const m = line.match(ITEM_LINE_RE);
    if (m) {
      const title = m[1].trim();
      const price = Number(m[2]);
      if (title.length >= 2 && Number.isFinite(price)) {
        items.push({
          title: title.slice(0, 256),
          quantity: 1,
          unitPrice: price,
          totalPrice: price,
          inferredCategory: categoriseGoogleItem(title),
        });
      }
    }
  }

  if (total == null && items.length === 0) return null;

  return {
    vendor: 'google',
    vendorName: 'Google',
    orderDate,
    orderId,
    total,
    currency: null,
    paymentLast4: last4,
    items,
    notes: null,
  };
}
