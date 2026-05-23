import { expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractApplePurchasesFromDom } from './apple';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../fixtures/apple-reportaproblem.html'), 'utf-8');

test('extracts two purchases from the Apple fixture', () => {
  document.body.innerHTML = html;
  const orders = extractApplePurchasesFromDom(document);
  expect(orders).toHaveLength(2);
  expect(orders[0].orderDate).toBe('2026-05-12');
  expect(orders[0].total).toBe(4.99);
  expect(orders[0].items).toHaveLength(1);
  expect(orders[0].items[0].title).toBe('iCloud+ with 50 GB');
  expect(orders[1].orderDate).toBe('2026-05-03');
  expect(orders[1].total).toBe(12.99);
});
