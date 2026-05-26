import { expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractApplePurchasesFromDom } from './apple';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../fixtures/apple-reportaproblem.html'), 'utf-8');

test('extracts settled purchases and skips the pending bucket', () => {
  document.body.innerHTML = html;
  const orders = extractApplePurchasesFromDom(document);

  expect(orders).toHaveLength(2);

  expect(orders[0]).toMatchObject({
    vendorOrderId: 'MM63QG6X09',
    orderDate: '2026-05-25',
    total: 12.99,
    currency: 'CAD',
    paymentLast4: null,
    rawSource: 'bookmarklet-apple-v1',
  });
  expect(orders[0].items).toHaveLength(1);
  expect(orders[0].items[0].title).toBe('Premium Lifetime');
  expect(orders[0].items[0].unitPrice).toBe(12.99);

  expect(orders[1]).toMatchObject({
    vendorOrderId: 'R24YW5T998T2QQ',
    orderDate: '2026-05-03',
    total: 0,
  });
  expect(orders[1].items[0].title).toBe('Flipper Mobile App');
  expect(orders[1].items[0].unitPrice).toBe(0);
});
