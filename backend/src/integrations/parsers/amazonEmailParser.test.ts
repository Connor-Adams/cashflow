import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonReceiptEmail } from './amazon';

test('multi-quantity items: listed price is the unit price, line total = unit x qty', () => {
  const body = [
    'Order #114-1234567-1234567',
    'Placed on May 21, 2026',
    '',
    'Item One',
    'Quantity: 1',
    '$24.99',
    '',
    'Item Two',
    'Quantity: 2',
    '$9.99',
    '',
    'Order Subtotal: $44.97',
    'Shipping & handling: $0.00',
    'Tax: $5.39',
    'Order Total: $50.36',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order.total, 50.36);
  assert.equal(order.items.length, 2);
  assert.equal(order.items[0].unitPrice, 24.99);
  assert.equal(order.items[0].totalPrice, 24.99);
  assert.equal(order.items[1].quantity, 2);
  assert.equal(order.items[1].unitPrice, 9.99);
  assert.equal(order.items[1].totalPrice, 19.98);
  // Line totals reconcile with the stated subtotal (24.99 + 2x9.99 = 44.97).
  const sum = order.items.reduce((acc, item) => acc + (item.totalPrice ?? 0), 0);
  assert.equal(Math.round(sum * 100), 4497);
});

test('thousands separators: comma-grouped totals and item prices parse', () => {
  const body = [
    'Order #114-7654321-7654321',
    'Placed on May 21, 2026',
    '',
    'Standing Desk',
    'Quantity: 1',
    '$1,049.00',
    '',
    'Order Subtotal: $1,049.00',
    'Tax: $185.56',
    'Order Total: $1,234.56',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order.total, 1234.56);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].title, 'Standing Desk');
  assert.equal(order.items[0].unitPrice, 1049);
  assert.equal(order.items[0].totalPrice, 1049);
});

test('decimal-comma totals (no period) still parse as cents', () => {
  const body = ['Order #114-1111111-1111111', 'Order Total: 44,97'].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order.total, 44.97);
});

test('populates structured subtotal/tax, not just notes', () => {
  const body = [
    'Order #114-1234567-1234567',
    'Placed on May 21, 2026',
    'Widget',
    'Quantity: 1',
    '$44.97',
    'Order Subtotal: $44.97',
    'Shipping & handling: $0.00',
    'Tax: $5.39',
    'Order Total: $50.36',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.tax, 5.39);
  assert.equal(order!.subtotal, 44.97);
  assert.equal(order!.total, 50.36);
  // tax and shipping must NOT appear in notes
  assert.ok(!order!.notes?.includes('Tax:'), 'notes must not contain Tax line');
  assert.ok(!order!.notes?.includes('Shipping:'), 'notes must not contain Shipping line');
});

test('detects CAD currency from CDN$ prefix', () => {
  const body = [
    'Order #114-9999999-9999999',
    'CDN$ 29.99',
    'Order Total: CDN$ 29.99',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.currency, 'CAD');
});

test('detects USD currency from US$ prefix', () => {
  const body = [
    'Order #114-8888888-8888888',
    'US$ 19.99',
    'Order Total: US$ 19.99',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.currency, 'USD');
});

test('currency is null when no currency prefix present', () => {
  const body = ['Order #114-7777777-7777777', 'Order Total: 44.97'].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.currency, null);
});
