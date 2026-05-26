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
  return `${m[3]}-${month}-${m[2].padStart(2, '0')}`;
}

function parseAmount(text: string): number | null {
  if (/free/i.test(text)) return 0;
  const m = text.replace(/[,\s]+/g, ' ').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

// Backend caps POST /capture/orders at 1000 orders per request. Apple lifetime
// history can exceed 600; truncate to the most recent batch (DOM order is
// reverse-chronological on reportaproblem.apple.com).
const MAX_ORDERS = 1000;

export function extractApplePurchasesFromDom(doc: Document): CapturedOrder[] {
  const purchases = Array.from(doc.querySelectorAll('.purchase'));
  const orders: CapturedOrder[] = [];
  for (const p of purchases) {
    if (orders.length >= MAX_ORDERS) break;
    // The "PENDING PURCHASES" bucket is a synthetic aggregate with no date or
    // total — skip it so we only emit settled invoices.
    if (
      p.querySelector(
        '[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Label.PendingPurchases"]',
      )
    ) {
      continue;
    }
    const dateText =
      p
        .querySelector('[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Display.Date"]')
        ?.textContent?.trim() ?? '';
    const orderDate = parseDate(dateText);
    if (!orderDate) continue;

    const vendorOrderId =
      p
        .querySelector('[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Display.WebOrder"]')
        ?.textContent?.trim() || null;

    const totalText =
      p
        .querySelector('[data-auto-test-id="RAP2.PurchaseList.Display.Invoice.Amount"]')
        ?.textContent?.trim() ?? '';
    const total = parseAmount(totalText);
    if (total == null) continue;

    const items = Array.from(p.querySelectorAll('li.pli')).map((li) => {
      const titleEl = li.querySelector(
        '[data-auto-test-id^="RAP2.PurchaseList.PLIDetails.Display.Title."]',
      );
      // Apple wraps the visible title in a nested div with aria-label. Prefer
      // aria-label so we don't pick up whitespace from surrounding markup.
      const aria = titleEl?.querySelector('[aria-label]')?.getAttribute('aria-label');
      const title = (aria ?? titleEl?.textContent ?? '').trim() || 'Unknown item';
      const priceText =
        li
          .querySelector('[data-auto-test-id^="RAP2.PurchaseList.PLIDetails.Display.Price."]')
          ?.textContent?.trim() ?? '';
      const unitPrice = parseAmount(priceText);
      return { title, quantity: 1, unitPrice, totalPrice: unitPrice };
    });

    orders.push({
      vendorOrderId,
      orderDate,
      total,
      // TODO: detect currency from DOM. Apple shows a bare "$" for both CAD
      // (Canadian Apple ID) and USD (US Apple ID) — locale lives in account
      // settings, not the row. Defaulting to CAD matches existing scraper.
      currency: 'CAD',
      // Card last4 isn't surfaced in the collapsed purchase row; it lives on
      // the invoice screen behind a click. Leave null and let the backend
      // backfill match by date + amount.
      paymentLast4: null,
      items,
      rawSource: 'bookmarklet-apple-v1',
    });
  }
  return orders;
}
