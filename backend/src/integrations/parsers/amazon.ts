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

// Currency symbols pattern: CDN$/CA$/US$ or bare $. Used by both the optional
// prefix (for totals) and the required prefix (for per-item prices).
const CURRENCY_SYMBOLS = '(?:CDN|CA|US)\\$|\\$';
// Currency prefix: optional CDN$/CA$/US$ or bare $ — letters must NOT be
// captured into the numeric group; the outer (?:…)? makes the whole prefix optional.
const CURRENCY_PREFIX = `(?:${CURRENCY_SYMBOLS})?\\s*`;
// Required currency prefix — for contexts where a $ (or CDN$/CA$/US$) must be present.
const CURRENCY_PREFIX_REQUIRED = `(?:${CURRENCY_SYMBOLS})\\s*`;

const ORDER_ID_RE = /\bOrder\s*#?\s*([0-9]{3}-[0-9]{7}-[0-9]{7})\b/i;
const TOTAL_RE = new RegExp(`\\bOrder\\s*Total\\b\\s*[:\\-]?\\s*${CURRENCY_PREFIX}${AMOUNT_SRC}`, 'i');
const SUBTOTAL_RE = new RegExp(`\\bOrder\\s*Subtotal\\b\\s*[:\\-]?\\s*${CURRENCY_PREFIX}${AMOUNT_SRC}`, 'i');
const TAX_RE = new RegExp(`\\bTax\\b\\s*[:\\-]?\\s*${CURRENCY_PREFIX}${AMOUNT_SRC}`, 'i');
// DATE_RE: matches "Placed on", "Order placed", "Order Date:", standalone "Date:",
// and ship-confirm phrasings "Arriving <date>" / "Shipped on <date>".
const DATE_RE = /\b(?:Placed\s*on|Order\s*placed|Order\s*Date|Date|Arriving|Shipped\s*on)\b\s*[:\-]?\s*([A-Za-z]{3,9}\s+[0-9]{1,2},?\s+[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;
const QUANTITY_RE = /\bQuantity\s*[:\-]?\s*([0-9]+)/i;
const PRICE_RE = new RegExp(`${CURRENCY_PREFIX_REQUIRED}((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\\.[0-9]{2})`);
// LAST4_RE: matches "ending in 1234", "ending with 1234", and card-network-prefixed
// forms like "Visa ending in 1234", "Mastercard ending with 1234".
const LAST4_RE = /(?:(?:Visa|Mastercard|Amex|American\s*Express|Discover)\s+)?ending\s+(?:in|with)\s+(\d{4})/i;

/** '1,234.56' (thousands commas) and '44,97' (decimal comma) both parse. */
function parseAmount(raw: string): number {
  if (!raw.includes('.') && /,[0-9]{2}$/.test(raw)) {
    return Number(`${raw.slice(0, -3).replace(/,/g, '')}.${raw.slice(-2)}`);
  }
  return Number(raw.replace(/,/g, ''));
}

/**
 * Detects the currency used in the email body. Returns null when ambiguous.
 *
 * Anchors every pattern to an adjacent digit so that an incidental currency
 * symbol in non-price prose (e.g. "£ sterling deposits are handled …") does
 * not flip the detected currency away from a clearly-priced CAD order.
 */
function detectCurrency(body: string): string | null {
  // CDN$/CA$ prefix adjacent to digits, or CAD adjacent to digits (e.g. "44.97 CAD")
  if (/CDN\$\s*\d|CA\$\s*\d|\d[\s.]*CAD\b|\bCAD\s*\d/.test(body)) return 'CAD';
  // US$ prefix adjacent to digits, or USD adjacent to digits
  if (/US\$\s*\d|\d[\s.]*USD\b|\bUSD\s*\d/.test(body)) return 'USD';
  // £ adjacent to digits, or GBP adjacent to digits
  if (/£\s*\d|\d[\s.]*GBP\b|\bGBP\s*\d/.test(body)) return 'GBP';
  // € adjacent to digits, or EUR adjacent to digits
  if (/€\s*\d|\d[\s.]*EUR\b|\bEUR\s*\d/.test(body)) return 'EUR';
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

  // Refund/cancellation emails are out of scope — return null rather than
  // creating a spurious positive-amount order.
  const isRefundOrCancellation = /\b(?:cancell?ation|cancell?ed|your\s+order\s+has\s+been\s+cancel|we(?:'ve|\s+have)\s+(?:issued|processed)\s+(?:a|your)\s+refund|your\s+refund\s+of)\b/i.test(body);
  if (isRefundOrCancellation) return null;

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
