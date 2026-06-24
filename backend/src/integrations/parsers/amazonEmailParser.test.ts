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

test('incidental £ in non-price prose does NOT override CDN$-priced order currency', () => {
  // A CDN$-priced Amazon.ca order whose body also contains "£" in a non-price
  // context (e.g. footer text about payment policies) must still detect as CAD,
  // not GBP.  We use a bare $ total so TOTAL_RE fires normally; the CDN$ prefix
  // on the per-item price is what signals CAD.
  const body = [
    'Order #114-6666666-6666666',
    'Placed on June 1, 2026',
    'Widget',
    'Quantity: 1',
    'CDN$ 29.99',
    'Order Subtotal: $29.99',
    'Tax: $3.90',
    'Order Total: $33.89',
    // incidental non-price pound sign in footer prose — must NOT flip currency
    'Prices shown in £ sterling for UK customers only.',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.currency, 'CAD', 'incidental £ prose must not flip a CDN$-priced order to GBP');
  assert.equal(order!.total, 33.89);
});

test('detectCurrency still works for standalone CAD/USD codes adjacent to amounts', () => {
  // "44.97 CAD" — digit immediately followed by space then CAD
  const cadBody = [
    'Order #114-5555555-5555555',
    'Order Total: $44.97',
    'Total: 44.97 CAD',
  ].join('\n');
  const cadOrder = parseAmazonReceiptEmail(cadBody);
  assert.ok(cadOrder);
  assert.equal(cadOrder!.currency, 'CAD');

  // "US$ 19.99" — US$ prefix adjacent to digit (existing pattern)
  const usdBody = [
    'Order #114-4444444-4444444',
    'US$ 19.99',
    'Order Total: $19.99',
  ].join('\n');
  const usdOrder = parseAmazonReceiptEmail(usdBody);
  assert.ok(usdOrder);
  assert.equal(usdOrder!.currency, 'USD');
});

// ── Task 8: new fixture coverage ─────────────────────────────────────────────

test('extracts ISO order date and card last4 (Visa ending in NNNN)', () => {
  const body = [
    'Your Amazon.ca order',
    'Order # 701-9999999-0000000',
    'Order Date: 2026-06-09',
    'Payment method: Visa ending in 1234',
    'Item A',
    'Quantity: 1',
    '$10.00',
    'Order Total: $10.00',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.orderDate, '2026-06-09');
  assert.equal(order!.paymentLast4, '1234');
});

test('extracts last4 with "ending with" phrasing', () => {
  const body = [
    'Order #114-1234567-9990001',
    'Placed on June 10, 2026',
    'Payment: Mastercard ending with 5678',
    'Widget',
    'Quantity: 1',
    '$25.00',
    'Order Total: $25.00',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.paymentLast4, '5678');
});

test('extracts date from ship-confirm "Arriving" phrasing', () => {
  // Ship-confirm emails use "Arriving <date>" rather than "Placed on".
  const body = [
    'Your order has shipped',
    'Order #114-5551111-2222222',
    'Arriving June 15, 2026',
    'USB-C Hub',
    'Quantity: 1',
    '$39.99',
    'Order Total: $39.99',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.orderDate, '2026-06-15');
});

test('extracts date from ship-confirm "Shipped on" phrasing', () => {
  const body = [
    'Your order has shipped',
    'Order #114-7772222-3333333',
    'Shipped on June 12, 2026',
    'Desk Lamp',
    'Quantity: 1',
    '$45.00',
    'Order Total: $45.00',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.orderDate, '2026-06-12');
});

test('CDN$-prefixed total/subtotal/tax amounts parse correctly', () => {
  // Real Canadian Amazon emails write "CDN$ 50.36" on summary lines.
  const body = [
    'Your Amazon.ca order',
    'Order #114-3333333-4444444',
    'Placed on June 1, 2026',
    'Premium Webcam',
    'Quantity: 1',
    'CDN$ 43.70',
    'Order Subtotal: CDN$ 43.70',
    'Shipping & handling: CDN$ 0.00',
    'Tax: CDN$ 5.68',
    'Order Total: CDN$ 50.36',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.total, 50.36);
  assert.equal(order!.subtotal, 43.70);
  assert.equal(order!.tax, 5.68);
  assert.equal(order!.currency, 'CAD');
});

test('US$-prefixed total/subtotal/tax amounts parse correctly', () => {
  const body = [
    'Your Amazon.com order',
    'Order #114-2222222-3333333',
    'Placed on June 2, 2026',
    'Keyboard',
    'Quantity: 1',
    'US$ 89.00',
    'Order Subtotal: US$ 89.00',
    'Tax: US$ 7.34',
    'Order Total: US$ 96.34',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.total, 96.34);
  assert.equal(order!.subtotal, 89.00);
  assert.equal(order!.tax, 7.34);
  assert.equal(order!.currency, 'USD');
});

test('digital receipt (Audible) yields title and total', () => {
  // Audible/Kindle receipts have a simpler layout without per-item Quantity lines.
  const body = [
    'Thank you for your Audible purchase',
    'Order #D01-1234567-7654321',
    'Order Date: 2026-06-08',
    'Payment method: Visa ending in 4321',
    '',
    'The Great Novel (Unabridged)',
    '$24.95',
    '',
    'Order Total: $24.95',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.total, 24.95);
  assert.ok(order!.items.length >= 1, 'should yield at least one item');
  assert.equal(order!.items[0].title, 'The Great Novel (Unabridged)');
  assert.equal(order!.paymentLast4, '4321');
});

test('refund email returns null (do not create a spurious order)', () => {
  const body = [
    'Your refund has been processed',
    'Order #114-9876543-2109876',
    'We have issued a refund of $29.99 for your recent order.',
    'Refund amount: $29.99',
    'Order Total: $29.99',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.equal(order, null, 'refund emails must return null');
});

test('cancellation email returns null (do not create a spurious order)', () => {
  const body = [
    'Your order has been cancelled',
    'Order #114-1111111-9999999',
    'We have cancelled your order as requested.',
    'Item: Wireless Mouse',
    'Order Total: $19.99',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.equal(order, null, 'cancellation emails must return null');
});
