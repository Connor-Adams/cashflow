/**
 * Apple receipt-email parser.
 *
 * Apple emails (`no_reply@email.apple.com`) follow a fairly stable structure
 * regardless of language locale:
 *
 *   Apple ID    you@example.com
 *   Order ID    M0XXXXXXXXX
 *   Date        20 May 2026
 *
 *   <item title>                       $0.99
 *   <subscription type>
 *
 *   Subtotal                           $13.99
 *   Tax                                $1.82
 *   Total                              $15.81
 *
 * The HTML version is busy but the plain-text version (extracted by
 * gmail.extractMessageBody) is reliable enough for regex.
 */
import type { ExtractedReceiptOrder, ExtractedReceiptItem } from '../../ai/extractReceiptItems';

const ORDER_ID_RE = /(?:Order\s*ID|Document\s*No\.?)\s*[:\-]?\s*([A-Z0-9]{5,32})/i;
const TOTAL_RE = /\bTotal\b\s*[:\-]?\s*\$?\s*([0-9]+(?:[.,][0-9]{2}))/i;
const DATE_RE = /\b(Date|Invoice\s*Date|Order\s*Date)\b\s*[:\-]?\s*([0-9]{1,2}[ /\-][A-Za-z]{3,9}[ /\-][0-9]{2,4}|[A-Za-z]{3,9}\s+[0-9]{1,2},?\s+[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;
const ACCOUNT_RE = /\bApple\s*ID\b\s*[:\-]?\s*([^\s@]+@[^\s@]+\.[^\s@]+)/i;
const ITEM_LINE_RE = /^(.{2,120}?)\s+\$\s*([0-9]+(?:\.[0-9]{2})?)\s*$/;
const LAST4_RE = /\b(?:ending\s*in|last\s*4|x{2,}|·{2,})\s*(\d{4})\b/i;

function normalizeDate(raw: string): string | null {
  // Try several common Apple date formats.
  const trimmed = raw.trim();
  const direct = new Date(trimmed);
  if (!isNaN(direct.getTime())) {
    const y = direct.getUTCFullYear();
    const m = String(direct.getUTCMonth() + 1).padStart(2, '0');
    const d = String(direct.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

function categoriseAppleItem(title: string): string | null {
  const t = title.toLowerCase();
  if (/icloud|cloud storage|\bgb\b|\btb\b/i.test(t)) return 'Subscriptions';
  if (/apple\s*music|spotify/i.test(t)) return 'Subscriptions';
  if (/apple\s*tv\+?|streaming/i.test(t)) return 'Subscriptions';
  if (/apple\s*one|apple\s*arcade/i.test(t)) return 'Subscriptions';
  if (/applecare/i.test(t)) return 'Insurance';
  return null;
}

export function parseAppleReceipt(body: string): ExtractedReceiptOrder | null {
  if (!/apple|itunes|icloud|app\s*store/i.test(body)) return null;

  const orderId = body.match(ORDER_ID_RE)?.[1] ?? null;
  const totalMatch = body.match(TOTAL_RE);
  const total = totalMatch ? Number(totalMatch[1].replace(',', '.')) : null;
  const dateMatch = body.match(DATE_RE);
  const orderDate = dateMatch ? normalizeDate(dateMatch[2]) : null;
  const last4 = body.match(LAST4_RE)?.[1] ?? null;
  const accountEmail = body.match(ACCOUNT_RE)?.[1] ?? null;

  // Extract items: walk lines, gather any "Title $X.XX" pattern that
  // isn't a Total / Subtotal / Tax line.
  const items: ExtractedReceiptItem[] = [];
  for (const lineRaw of body.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (/^\s*(total|subtotal|tax|sub\s*-?total|grand\s*total)\b/i.test(line)) continue;
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
          inferredCategory: categoriseAppleItem(title),
        });
      }
    }
  }

  // If we extracted no total and no items, bail — let AI try.
  if (total == null && items.length === 0) return null;

  return {
    vendor: 'apple',
    vendorName: 'Apple',
    orderDate,
    orderId,
    subtotal: null,
    tax: null,
    total,
    currency: null, // Apple emails localise; let downstream default
    paymentLast4: last4,
    tenders: [],
    items,
    notes: accountEmail ? `Apple ID: ${accountEmail}` : null,
  };
}
