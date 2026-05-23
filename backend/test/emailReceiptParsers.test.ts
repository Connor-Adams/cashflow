import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryDeterministicParse } from '../src/integrations/parsers';

test('Apple parser extracts iCloud subscription receipt', () => {
  const body = `
Apple ID    you@example.com
Order ID    MABC12345
Date        May 20, 2026

iCloud+ with 200 GB of Storage    $3.99
Monthly subscription

Subtotal    $3.99
Tax    $0.00
Total    $3.99

Visa ending in 1234
  `;
  const r = tryDeterministicParse({
    fromAddress: 'no_reply@email.apple.com',
    subject: 'Your receipt from Apple',
    body,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.parser, 'apple');
  assert.equal(r.order.vendor, 'apple');
  assert.equal(r.order.total, 3.99);
  assert.equal(r.order.orderId, 'MABC12345');
  assert.equal(r.order.paymentLast4, '1234');
  assert.ok(r.order.items.length >= 1);
  assert.ok(/iCloud/.test(r.order.items[0].title));
  assert.equal(r.order.items[0].inferredCategory, 'Subscriptions');
});

test('Google Play parser extracts YouTube Premium receipt', () => {
  const body = `
Google Play

Order number: GPA.1234-5678-9012-34567
Order date: May 21, 2026

YouTube Premium    $13.99
Monthly subscription

Total    $13.99

Visa ending in 5678
  `;
  const r = tryDeterministicParse({
    fromAddress: 'googleplay-noreply@google.com',
    subject: 'Your Google Play receipt',
    body,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.parser, 'google');
  assert.equal(r.order.vendor, 'google');
  assert.equal(r.order.total, 13.99);
  assert.equal(r.order.orderId, 'GPA.1234-5678-9012-34567');
  assert.ok(r.order.items.some((it) => /YouTube/.test(it.title)));
});

test('Amazon parser extracts multi-item order confirmation', () => {
  const body = `
Hello Connor,

Thank you for your order. We'll send a confirmation when your item ships.

Order #114-1234567-1234567
Placed on May 21, 2026

USB-C to Lightning Cable
Quantity: 2
$19.98

Mechanical Keyboard
Quantity: 1
$89.99

Order Subtotal: $109.97
Shipping & handling: $0.00
Tax: $11.00
Order Total: $120.97

Visa ending in 9999
  `;
  const r = tryDeterministicParse({
    fromAddress: 'auto-confirm@amazon.com',
    subject: 'Your Amazon.com order of "Mechanical Keyboard"',
    body,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.parser, 'amazon');
  assert.equal(r.order.vendor, 'amazon');
  assert.equal(r.order.orderId, '114-1234567-1234567');
  assert.equal(r.order.total, 120.97);
  assert.equal(r.order.paymentLast4, '9999');
  assert.equal(r.order.items.length, 2);
  const titles = r.order.items.map((it) => it.title);
  assert.ok(titles.some((t) => /USB-C to Lightning/i.test(t)));
  assert.ok(titles.some((t) => /Mechanical Keyboard/i.test(t)));
});

test('parser returns no_vendor_parser for unknown senders', () => {
  const r = tryDeterministicParse({
    fromAddress: 'receipts@randompizzeria.com',
    subject: 'Your pizza order',
    body: 'Thanks for your order. Total $25.99',
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'no_vendor_parser');
});

test('Apple parser returns null when the body has no Apple markers', () => {
  const r = tryDeterministicParse({
    fromAddress: 'no_reply@email.apple.com',
    subject: 'Verification code',
    body: 'Your verification code is 123456. Do not share this code.',
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'apple_parser_no_match');
});
