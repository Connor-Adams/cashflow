import type { CapturedOrder } from './types';

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
      } else if (label.includes('order #') || label.includes('order id') || label.includes('order number')) {
        vendorOrderId = value;
      }
    }

    if (!vendorOrderId) {
      const bdi = card.querySelector('bdi');
      if (bdi?.textContent) vendorOrderId = bdi.textContent.trim();
    }

    const items = Array.from(card.querySelectorAll('.yohtmlc-product-title, a.yohtmlc-product-title, .a-link-normal.yohtmlc-product-title'))
      .map((el) => (el.textContent ?? '').trim())
      .filter((t) => t.length > 0)
      .map((title) => ({ title }));

    if (orderDate && total != null) {
      orders.push({
        vendorOrderId,
        orderDate,
        total,
        // TODO: detect currency from DOM (e.g. "CDN$" vs "$" vs "USD") — hardcoded for v1
        currency: 'CAD',
        paymentLast4: null,
        items,
        rawSource: 'bookmarklet-amazon-v1',
      });
    }
  }
  return orders;
}
