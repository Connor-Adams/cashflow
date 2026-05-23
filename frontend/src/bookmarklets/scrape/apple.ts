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
  const m = text.replace(/[,\s]+/g, ' ').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

export function extractApplePurchasesFromDom(doc: Document): CapturedOrder[] {
  const rows = Array.from(doc.querySelectorAll('.purchase-row, [data-purchase-row], li.purchase'));
  const orders: CapturedOrder[] = [];
  for (const row of rows) {
    const dateText = (row.querySelector('.purchase-date, [data-purchase-date]')?.textContent ?? '').trim();
    const titleText = (row.querySelector('.purchase-title, [data-purchase-title]')?.textContent ?? '').trim();
    const amountText = (row.querySelector('.purchase-amount, [data-purchase-amount]')?.textContent ?? '').trim();
    const orderDate = parseDate(dateText);
    const total = parseAmount(amountText);
    if (orderDate && total != null && titleText) {
      orders.push({
        vendorOrderId: null,
        orderDate,
        total,
        // TODO: detect currency from DOM (e.g. "CDN$" vs "$" vs "USD") — hardcoded for v1
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: titleText, totalPrice: total, quantity: 1 }],
        rawSource: 'bookmarklet-apple-v1',
      });
    }
  }
  return orders;
}
