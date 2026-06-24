/**
 * Amazon receipt-email parser.
 *
 * Multiple email formats: auto-confirm (order placed), ship-confirm (shipped),
 * order-update (cancellation/refund/address change), digital-no-reply (Kindle/
 * digital). We mainly target auto-confirm and digital-no-reply because those
 * actually carry totals; ship-confirm rarely shows the total again.
 *
 * Amazon's plain-text fallback (when text/html is the only part) tends to
 * have a structure like:
 *
 *   Hello <name>,
 *   Thank you for your order. We'll send a confirmation when your item ships.
 *
 *   Order #114-1234567-1234567
 *   Placed on May 21, 2026
 *
 *   <Item Title>
 *   Quantity: 1
 *   $24.99
 *
 *   <Item Title 2>
 *   Quantity: 2
 *   $9.99
 *
 *   Order Subtotal:  $44.97
 *   Shipping & handling: $0.00
 *   Tax: $5.39
 *   Order Total: $50.36
 */
import type { ExtractedReceiptOrder, ExtractedReceiptItem } from '../../ai/extractReceiptItems';

// Amount: digits with optional thousands commas and a 2-digit decimal tail
// ('1,234.56'), or a bare decimal comma ('44,97' in EU-formatted emails).
const AMOUNT_SRC = '((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:[.,][0-9]{2}))';

const ORDER_ID_RE = /\bOrder\s*#?\s*([0-9]{3}-[0-9]{7}-[0-9]{7})\b/i;
const TOTAL_RE = new RegExp(`\\bOrder\\s*Total\\b\\s*[:\\-]?\\s*\\$?\\s*${AMOUNT_SRC}`, 'i');
const SUBTOTAL_RE = new RegExp(`\\bOrder\\s*Subtotal\\b\\s*[:\\-]?\\s*\\$?\\s*${AMOUNT_SRC}`, 'i');
const TAX_RE = new RegExp(`\\bTax\\b\\s*[:\\-]?\\s*\\$?\\s*${AMOUNT_SRC}`, 'i');
const DATE_RE = /\b(?:Placed\s*on|Order\s*placed|Date|Order\s*Date)\b\s*[:\-]?\s*([A-Za-z]{3,9}\s+[0-9]{1,2},?\s+[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;
const QUANTITY_RE = /\bQuantity\s*[:\-]?\s*([0-9]+)/i;
const PRICE_RE = /\$\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\.[0-9]{2})/;
const LAST4_RE = /(?:ending\s*in)\s*(\d{4})/i;

/** '1,234.56' (thousands commas) and '44,97' (decimal comma) both parse. */
function parseAmount(raw: string): number {
  if (!raw.includes('.') && /,[0-9]{2}$/.test(raw)) {
    return Number(`${raw.slice(0, -3).replace(/,/g, '')}.${raw.slice(-2)}`);
  }
  return Number(raw.replace(/,/g, ''));
}

/** Detects the currency symbol used in the email body. Returns null when ambiguous. */
function detectCurrency(body: string): string | null {
  if (/CDN\$|CA\$|\bCAD\b/.test(body)) return 'CAD';
  if (/US\$|\bUSD\b/.test(body)) return 'USD';
  if (/£|\bGBP\b/.test(body)) return 'GBP';
  if (/€|\bEUR\b/.test(body)) return 'EUR';
  return null;
}

function normalizeDate(raw: string): string | null {
  const d = new Date(raw.trim());
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Walk lines and group them into items. The Amazon plain-text layout is
 * roughly: [title line(s)] [Quantity: N] [$ price] — but inter-item spacing
 * varies. We scan forward from each "$ price" line and attribute the most
 * recent non-empty non-meta line above it as the title.
 */
function extractItems(body: string): ExtractedReceiptItem[] {
  const items: ExtractedReceiptItem[] = [];
  const lines = body.split(/\r?\n/);
  let pendingTitle: string | null = null;
  let pendingQuantity = 1;
  const SUMMARY_RE = /^\s*(order\s*subtotal|order\s*total|subtotal|total|tax|shipping|estimated\s*tax|gift\s*card)\b/i;

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;

    if (SUMMARY_RE.test(line)) {
      pendingTitle = null;
      pendingQuantity = 1;
      continue;
    }

    const qty = line.match(QUANTITY_RE);
    if (qty) {
      const n = Number(qty[1]);
      if (Number.isFinite(n) && n > 0) pendingQuantity = Math.round(n);
      continue;
    }

    const price = line.match(PRICE_RE);
    if (price && pendingTitle) {
      // The per-item "$ price" line is the UNIT price: the docstring example's
      // subtotal only reconciles as 24.99 + 2 x 9.99 = 44.97.
      const unitPrice = parseAmount(price[1]);
      if (Number.isFinite(unitPrice) && unitPrice > 0) {
        items.push({
          title: pendingTitle.slice(0, 256),
          quantity: pendingQuantity,
          unitPrice,
          totalPrice: Math.round(unitPrice * pendingQuantity * 100) / 100,
          inferredCategory: null,
        });
        pendingTitle = null;
        pendingQuantity = 1;
      }
      continue;
    }

    // Treat as a candidate title.
    if (line.length >= 3 && line.length <= 200 && !/^[*=_\-]+$/.test(line)) {
      pendingTitle = line;
    }
  }
  return items;
}

export function parseAmazonReceiptEmail(body: string): ExtractedReceiptOrder | null {
  // We rely on the parser router to call us only for Amazon-sender emails.
  // As an extra safety: pass either if the body literally mentions Amazon-y
  // terms OR if it contains an Amazon-shaped order id (XXX-XXXXXXX-XXXXXXX).
  const looksAmazon =
    /amazon|amzn|kindle|prime\s*video|audible/i.test(body) || ORDER_ID_RE.test(body);
  if (!looksAmazon) return null;

  const orderId = body.match(ORDER_ID_RE)?.[1] ?? null;
  const totalMatch = body.match(TOTAL_RE) ?? body.match(SUBTOTAL_RE);
  const total = totalMatch ? parseAmount(totalMatch[1]) : null;
  const dateMatch = body.match(DATE_RE);
  const orderDate = dateMatch ? normalizeDate(dateMatch[1]) : null;
  const last4 = body.match(LAST4_RE)?.[1] ?? null;
  const items = extractItems(body);
  const taxRaw = body.match(TAX_RE)?.[1] ?? null;
  const subtotalMatch = body.match(SUBTOTAL_RE);
  const subtotal = subtotalMatch ? parseAmount(subtotalMatch[1]) : null;
  const currency = detectCurrency(body);

  if (total == null && items.length === 0) return null;

  return {
    vendor: 'amazon',
    vendorName: 'Amazon',
    orderDate,
    orderId,
    subtotal,
    tax: taxRaw != null ? parseAmount(taxRaw) : null,
    total,
    currency,
    paymentLast4: last4,
    tenders: [],
    items,
    notes: orderId ? `Order ${orderId}` : null,
  };
}
