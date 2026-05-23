import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractAmazonOrdersFromDom } from './amazon';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../fixtures/amazon-orders.html'), 'utf-8');

describe('extractAmazonOrdersFromDom', () => {
  test('extracts two orders from the Amazon fixture', () => {
    document.body.innerHTML = html;
    const orders = extractAmazonOrdersFromDom(document);
    expect(orders).toHaveLength(2);

    const first = orders[0];
    expect(first.vendorOrderId).toBe('112-1234567-1234567');
    expect(first.orderDate).toBe('2026-05-05');
    expect(first.total).toBe(42.5);
    expect(first.items.map((it) => it.title)).toEqual(['USB-C Cable 6ft', 'Wireless Mouse']);

    const second = orders[1];
    expect(second.vendorOrderId).toBe('112-7654321-7654321');
    expect(second.orderDate).toBe('2026-04-21');
    expect(second.total).toBe(18);
  });

  test('returns empty array on a page without order cards', () => {
    document.body.innerHTML = '<h1>No orders</h1>';
    const orders = extractAmazonOrdersFromDom(document);
    expect(orders).toEqual([]);
  });
});
