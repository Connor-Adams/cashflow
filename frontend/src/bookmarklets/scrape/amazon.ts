import type { CapturedItem, CapturedOrder } from './types';

function parseDate(text: string): string | null {
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  const m = text.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (!month) return null;
  const day = m[2].padStart(2, '0');
  return `${m[3]}-${month}-${day}`;
}

function parseTotal(text: string): number | null {
  const m = text.replace(/[,\s]+/g, ' ').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

/** Map an Amazon money string's currency marker to an ISO 4217 code. Bare "$"
 *  is ambiguous on Amazon (CA and US both render it), so default to CAD — the
 *  household default — and let the user correct outliers on the order. */
export function parseCurrencyCode(text: string): string {
  const t = text.toUpperCase();
  if (/CDN\$|CA\$|C\$|CAD/.test(t)) return 'CAD';
  if (/US\$|USD/.test(t)) return 'USD';
  if (/£|GBP/.test(t)) return 'GBP';
  if (/€|EUR/.test(t)) return 'EUR';
  return 'CAD';
}

function parseMoneyFrom(el: Element | null | undefined): number | null {
  if (!el) return null;
  return parseTotal(el.textContent ?? '');
}

function last4From(text: string): string | null {
  return text.match(/ending in\s*(\d{4})/i)?.[1] ?? text.match(/\b(\d{4})\b/)?.[1] ?? null;
}

function extractItems(card: Element): CapturedItem[] {
  const titleEls = Array.from(
    card.querySelectorAll('.yohtmlc-product-title, a.yohtmlc-product-title, .a-link-normal.yohtmlc-product-title'),
  );
  return titleEls
    .map((titleEl): CapturedItem | null => {
      const title = (titleEl.textContent ?? '').trim();
      if (!title) return null;
      const row =
        titleEl.closest('.order-card__list-item, .a-fixed-left-grid, .a-box') ?? titleEl.parentElement ?? card;
      const priceEl = row.querySelector('.a-price .a-offscreen, .a-color-price, .yohtmlc-item-price');
      const qtyEl = row.querySelector('.item-view-qty, .product-image__qty-label, .od-item-view-qty');
      const qtyNum = qtyEl ? Number((qtyEl.textContent ?? '').replace(/\D+/g, '')) : NaN;
      return {
        title,
        quantity: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1,
        unitPrice: null,
        totalPrice: parseMoneyFrom(priceEl),
      };
    })
    .filter((it): it is CapturedItem => it != null);
}

export function extractAmazonOrdersFromDom(doc: Document): CapturedOrder[] {
  const cards = Array.from(doc.querySelectorAll('.order-card, .js-order-card'));
  const seen = new Set<Element>();
  const unique = cards.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
  const orders: CapturedOrder[] = [];
  for (const card of unique) {
    const cols = Array.from(card.querySelectorAll('.order-header .a-column, .order-header div'));
    let orderDate: string | null = null;
    let total: number | null = null;
    let vendorOrderId: string | null = null;
    let currency = 'CAD';

    for (const col of cols) {
      const labelEl = col.querySelector('.label, .a-color-secondary.label');
      const valueEl = col.querySelector('.value, .a-color-secondary.value, bdi');
      const label = (labelEl?.textContent ?? '').trim().toLowerCase();
      const value = (valueEl?.textContent ?? '').trim();
      if (!value) continue;
      if (label.includes('order placed') || label.includes('placed')) {
        orderDate = parseDate(value) ?? orderDate;
      } else if (label.includes('total')) {
        total = parseTotal(value) ?? total;
        currency = parseCurrencyCode(value);
      } else if (label.includes('order #') || label.includes('order id') || label.includes('order number')) {
        vendorOrderId = value;
      }
    }

    if (!vendorOrderId) {
      const bdi = card.querySelector('bdi');
      if (bdi?.textContent) vendorOrderId = bdi.textContent.trim();
    }

    const paymentLast4 = last4From(card.textContent ?? '');
    const items = extractItems(card);

    if (orderDate && total != null) {
      orders.push({
        vendorOrderId,
        orderDate,
        total,
        currency,
        paymentLast4,
        items,
        rawSource: 'bookmarklet-amazon-v1',
      });
    }
  }
  return orders;
}
