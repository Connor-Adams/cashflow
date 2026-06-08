/**
 * Unit tests for the Amazon pipeline modules.
 * Pure functions only — no DB, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonReceiptEmail } from './parseAmazonReceiptEmail';
import {
  amazonOrderDedupeKey,
  normalizeAmazonOrder,
  normalizeTitle,
} from './normalizeAmazonOrder';
import { isAmazonLikeMerchant, scoreAmazonOrderMatch } from './matcher';
import { categorizeAmazonItem } from './categories';
import { ExternalOrder } from '../models/ExternalOrder';
import { Transaction } from '../models/Transaction';

// ─── normalizeAmazonOrder ──────────────────────────────────────────────────

test('normalizeAmazonOrder: empty/whitespace-only item titles are filtered out', () => {
  const normalized = normalizeAmazonOrder({
    vendorOrderId: '701-1111111-1111111',
    source: 'amazon_report',
    total: 25,
    items: [
      { title: 'USB-C Cable', totalPrice: 25 },
      { title: '   ', totalPrice: 0 },
      { title: '', totalPrice: 0 },
    ],
  });
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].title, 'USB-C Cable');
});

test('normalizeAmazonOrder: dedupeKey uses amazon:order:<id> when vendorOrderId set', () => {
  const normalized = normalizeAmazonOrder({
    vendorOrderId: '701-1234567-7654321',
    source: 'amazon_report',
    items: [{ title: 'Widget', totalPrice: 1 }],
  });
  assert.equal(normalized.dedupeKey, 'amazon:order:701-1234567-7654321');
});

test('normalizeAmazonOrder: dedupeKey uses amazon:fallback:<date>:<cents>:<hash> when no vendorOrderId', () => {
  const normalized = normalizeAmazonOrder({
    vendorOrderId: null,
    orderDate: '2026-05-01',
    total: 24.5,
    source: 'amazon_report',
    items: [{ title: 'USB-C Cable', totalPrice: 12.25 }],
  });
  assert.match(normalized.dedupeKey, /^amazon:fallback:2026-05-01:2450:[a-f0-9]{24}$/);
});

test('amazonOrderDedupeKey: stable under item reordering (sorted by normalizeTitle)', () => {
  const base = {
    vendorOrderId: null,
    orderDate: '2026-05-01',
    total: 30,
  } as const;
  const orderA = amazonOrderDedupeKey({
    ...base,
    items: [{ title: 'USB Cable' }, { title: 'Mouse' }, { title: 'Keyboard' }],
  });
  const orderB = amazonOrderDedupeKey({
    ...base,
    items: [{ title: 'Keyboard' }, { title: 'USB Cable' }, { title: 'Mouse' }],
  });
  assert.equal(orderA, orderB);
});

test('normalizeAmazonOrder: normalizeDate accepts ISO (already-ISO returns same date)', () => {
  const normalized = normalizeAmazonOrder({
    vendorOrderId: 'X',
    orderDate: '2026-05-15',
    source: 'amazon_report',
    items: [{ title: 'Widget' }],
  });
  assert.equal(normalized.orderDate, '2026-05-15');
});

test('normalizeAmazonOrder: normalizeDate accepts MM/DD/YY and prefixes "20" to 2-digit year', () => {
  const normalized = normalizeAmazonOrder({
    vendorOrderId: 'X',
    orderDate: '05/15/26',
    source: 'amazon_report',
    items: [{ title: 'Widget' }],
  });
  assert.equal(normalized.orderDate, '2026-05-15');
});

test('normalizeAmazonOrder: normalizeDate returns null for unparseable input', () => {
  const normalized = normalizeAmazonOrder({
    vendorOrderId: 'X',
    orderDate: 'tomorrow morning',
    source: 'amazon_report',
    items: [{ title: 'Widget' }],
  });
  assert.equal(normalized.orderDate, null);
});

test('normalizeAmazonOrder: quantity 0 → clamped to 1', () => {
  const normalized = normalizeAmazonOrder({
    vendorOrderId: 'X',
    source: 'amazon_report',
    items: [{ title: 'Widget', quantity: 0, totalPrice: 5 }],
  });
  assert.equal(normalized.items[0].quantity, 1);
});

test('normalizeAmazonOrder: currency defaults to CAD when missing', () => {
  const normalized = normalizeAmazonOrder({
    vendorOrderId: 'X',
    source: 'amazon_report',
    items: [{ title: 'Widget' }],
  });
  assert.equal(normalized.currency, 'CAD');
});

test('normalizeTitle: lowercases and collapses non-alphanumeric runs to single space', () => {
  assert.equal(normalizeTitle('USB-C Cable!! (10ft)'), 'usb c cable 10ft');
  assert.equal(normalizeTitle('  Widget   #2  '), 'widget 2');
});

// ─── parseAmazonReceiptEmail ───────────────────────────────────────────────

test('parseAmazonReceiptEmail: canonical email parses all fields and emits source=email', () => {
  const email = [
    'Hello,',
    'Your Amazon.ca order #701-1234567-7654321 has shipped.',
    'Item: USB-C Cable',
    'Order Total: $42.00',
    'Placed on May 15, 2026',
    'Card ending in 1234',
  ].join('\n');
  const order = parseAmazonReceiptEmail(email);
  assert.ok(order, 'parser returned a non-null result');
  assert.equal(order!.vendorOrderId, '701-1234567-7654321');
  assert.equal(order!.total, 42);
  assert.equal(order!.paymentLast4, '1234');
  assert.equal(order!.source, 'email');
  assert.equal(order!.orderDate, '2026-05-15');
  assert.equal(order!.items[0].title, 'USB-C Cable');
  assert.equal(order!.dedupeKey, 'amazon:order:701-1234567-7654321');
});

test('parseAmazonReceiptEmail: order-id regex requires 3-7-7 digit groups', () => {
  // 6-digit last group (701-1234567-7654321 trimmed to last 6) must NOT match.
  const bad =
    'Your order 701-1234567-765432 has shipped. Item: Widget\nTotal: $10.00';
  const order = parseAmazonReceiptEmail(bad);
  // Falls back: no orderId but total + title present → still returns non-null
  assert.ok(order);
  assert.equal(order!.vendorOrderId, null);
  // Good 3-7-7 must match.
  const good =
    'Your order 123-1234567-1234567 has shipped. Item: Widget\nTotal: $10.00';
  const okOrder = parseAmazonReceiptEmail(good);
  assert.equal(okOrder?.vendorOrderId, '123-1234567-1234567');
});

test('parseAmazonReceiptEmail: total matches across spacing variants', () => {
  const compact = parseAmazonReceiptEmail('Item: Widget\nGrand total: $42.00');
  assert.equal(compact?.total, 42);
  // findMoney lives inside parseAmazonReceiptEmail — it accepts arbitrary
  // whitespace between label and amount via `[^\d$-]*`.
  const spaced = parseAmazonReceiptEmail('Item: Widget\nOrder Total   $42.00');
  assert.equal(spaced?.total, 42);
});

test('parseAmazonReceiptEmail: returns null when no orderId, total, or title', () => {
  const order = parseAmazonReceiptEmail(
    'Hello from a non-Amazon vendor. We just say hi.',
  );
  assert.equal(order, null);
});

test('parseAmazonReceiptEmail: date extraction handles "Placed on", "Order Date", "ordered:" variants', () => {
  const a = parseAmazonReceiptEmail(
    'Order #701-1111111-1111111\nItem: Widget\nPlaced on May 15, 2026',
  );
  assert.equal(a?.orderDate, '2026-05-15');
  const b = parseAmazonReceiptEmail(
    'Order #701-1111111-1111111\nItem: Widget\nOrder Date: 2026-05-15',
  );
  assert.equal(b?.orderDate, '2026-05-15');
  const c = parseAmazonReceiptEmail(
    'Order #701-1111111-1111111\nItem: Widget\nordered: 05/15/26',
  );
  assert.equal(c?.orderDate, '2026-05-15');
});

test('parseAmazonReceiptEmail: title extraction prefers "Item:" then falls back to shipped/arriving body', () => {
  const a = parseAmazonReceiptEmail(
    'Order #701-1111111-1111111\nItem: Mechanical Keyboard\nTotal: $80',
  );
  assert.equal(a?.items[0].title, 'Mechanical Keyboard');

  const fallback = parseAmazonReceiptEmail(
    [
      'Order #701-1111111-1111111',
      'Total: $80',
      'Arriving tomorrow',
      'USB-C Hub Adapter',
    ].join('\n'),
  );
  // The shipped/arriving regex grabs the next line as the title.
  assert.equal(fallback?.items[0].title, 'USB-C Hub Adapter');
});

test('parseAmazonReceiptEmail: total + no orderId + no title → uses "Amazon purchase" fallback', () => {
  const order = parseAmazonReceiptEmail('Total: $99.00');
  assert.ok(order, 'parser returned non-null even without orderId / title');
  assert.equal(order!.total, 99);
  assert.equal(order!.vendorOrderId, null);
  assert.equal(order!.items[0].title, 'Amazon purchase');
});

// ─── matcher: scoreAmazonOrderMatch ────────────────────────────────────────

function txnFor(over: Partial<{
  date: string;
  merchantRaw: string;
  merchantClean: string;
  amount: string;
  notes: string | null;
  sourceReference: string | null;
}>) {
  const notes = 'notes' in over ? over.notes : null;
  const sourceReference = 'sourceReference' in over ? over.sourceReference : null;
  return Transaction.build({
    id: 1,
    accountId: 1,
    householdId: 1,
    createdByUserId: 1,
    importBatch: 'test',
    date: over.date ?? '2026-05-05',
    merchantRaw: over.merchantRaw ?? 'AMZN Mktp CA',
    merchantClean: over.merchantClean ?? 'AMZN Mktp CA',
    amount: over.amount ?? '-42.00',
    currency: 'CAD',
    notes,
    sourceReference,
    sourceRowFingerprint: 'fp',
  } as never);
}

function orderFor(over: Partial<{
  shipmentDate: string | null;
  orderDate: string | null;
  total: string;
  paymentLast4: string | null;
}>) {
  // Distinguish "explicitly null" from "key absent" so callers can disable
  // the date-bonus path by passing shipmentDate: null.
  const shipmentDate = 'shipmentDate' in over ? over.shipmentDate : '2026-05-03';
  const orderDate = 'orderDate' in over ? over.orderDate : null;
  const paymentLast4 = 'paymentLast4' in over ? over.paymentLast4 : null;
  return ExternalOrder.build({
    id: Math.floor(Math.random() * 100000),
    householdId: 1,
    vendor: 'amazon',
    dedupeKey: `key-${Math.random()}`,
    shipmentDate,
    orderDate,
    total: over.total ?? '42.00',
    currency: 'CAD',
    paymentLast4,
    source: 'amazon_report',
  } as never);
}

test('matcher: same-day same-amount non-Amazon merchant scores lower than Amazon-like merchant', () => {
  const order = orderFor({ shipmentDate: '2026-05-05', total: '42.00' });
  const local = txnFor({
    date: '2026-05-05',
    merchantRaw: 'Local Cafe',
    merchantClean: 'Local Cafe',
  });
  const amzn = txnFor({
    date: '2026-05-05',
    merchantRaw: 'AMZN Mktp CA',
    merchantClean: 'AMZN Mktp CA',
  });
  const localScore = scoreAmazonOrderMatch(local, order).confidence;
  const amznScore = scoreAmazonOrderMatch(amzn, order).confidence;
  assert.ok(amznScore > localScore, `expected amzn ${amznScore} > local ${localScore}`);
  // amount=+50 + date=+25 + amazon merchant=+15 = 90
  assert.equal(amznScore, 90);
  // amount=+50 + date=+25 + (no merchant bonus) = 75
  assert.equal(localScore, 75);
});

test('matcher: fuzzy date window — gap 3d → +25; gap 6d → 0; gap 11d → -15', () => {
  const order = orderFor({ shipmentDate: '2026-05-05', total: '42.00' });
  const merchantNoBonus = {
    merchantRaw: 'Local Cafe',
    merchantClean: 'Local Cafe',
  };

  // gap=3 (txn 3 days after order) → in 0-5 window → +25 on top of amount +50 = 75
  const gap3 = scoreAmazonOrderMatch(
    txnFor({ ...merchantNoBonus, date: '2026-05-08' }),
    order,
  ).confidence;
  assert.equal(gap3, 75);

  // gap=6 → outside 0-5 window AND within 10 days → no date bonus, no penalty → just +50 amount = 50
  const gap6 = scoreAmazonOrderMatch(
    txnFor({ ...merchantNoBonus, date: '2026-05-11' }),
    order,
  ).confidence;
  assert.equal(gap6, 50);

  // gap=11 → over 10 days → -15 penalty → 50 - 15 = 35
  const gap11 = scoreAmazonOrderMatch(
    txnFor({ ...merchantNoBonus, date: '2026-05-16' }),
    order,
  ).confidence;
  assert.equal(gap11, 35);
});

test('matcher: ambiguous orders — both score >=70 → both above-threshold', () => {
  // amount within 0.5 (+50) + date 0-5 (+25) → 75, two candidates both qualify.
  const orderA = orderFor({ shipmentDate: '2026-05-03', total: '42.00' });
  const orderB = orderFor({ shipmentDate: '2026-05-04', total: '42.25' });
  const txn = txnFor({ date: '2026-05-05', merchantRaw: 'Local Cafe', merchantClean: 'Local Cafe' });
  const scoreA = scoreAmazonOrderMatch(txn, orderA).confidence;
  const scoreB = scoreAmazonOrderMatch(txn, orderB).confidence;
  assert.ok(scoreA >= 70, `A=${scoreA}`);
  assert.ok(scoreB >= 70, `B=${scoreB}`);
});

test('matcher: ambiguous orders — both score equal but <70, both candidates (tie-on-best path)', () => {
  // amount within 0.5 (+50) + (no date bonus) + amazon merchant (+15) = 65, two candidates equal.
  // runAmazonMatching's filter includes:
  //   confidence >= 70 OR (best < 70 && confidence === best && best > 0)
  // We assert just the equal-score property here; the runAmazonMatching integration
  // test (amazonEnrichment.test.ts) covers the linking-on-tie behavior end-to-end.
  const orderA = orderFor({ shipmentDate: null, orderDate: null, total: '42.00' });
  const orderB = orderFor({ shipmentDate: null, orderDate: null, total: '42.25' });
  const txn = txnFor({ date: '2026-05-05' }); // AMZN-like merchant
  const scoreA = scoreAmazonOrderMatch(txn, orderA).confidence;
  const scoreB = scoreAmazonOrderMatch(txn, orderB).confidence;
  assert.equal(scoreA, 65);
  assert.equal(scoreB, 65);
});

test('matcher: payment last4 bonus — sourceReference="REF-1234" + paymentLast4="1234" → +20', () => {
  // Use a >$0.50 amount delta (+35) and a non-Amazon merchant so the base
  // score stays well below the 100 cap and the +20 bonus is observable.
  const baseOrder = orderFor({ shipmentDate: '2026-05-03', total: '40.50' });
  const orderWithLast4 = orderFor({
    shipmentDate: '2026-05-03',
    total: '40.50',
    paymentLast4: '1234',
  });
  const txn = txnFor({
    sourceReference: 'REF-1234',
    date: '2026-05-05',
    merchantRaw: 'Local Cafe',
    merchantClean: 'Local Cafe',
  });

  const noBonus = scoreAmazonOrderMatch(txn, baseOrder).confidence;
  const withBonus = scoreAmazonOrderMatch(txn, orderWithLast4).confidence;
  assert.equal(withBonus - noBonus, 20);
});

test('matcher: payment last4 bonus — notes="ending in 9999" matches paymentLast4=9999', () => {
  const baseOrder = orderFor({
    shipmentDate: '2026-05-03',
    total: '40.50',
  });
  const order = orderFor({
    shipmentDate: '2026-05-03',
    total: '40.50',
    paymentLast4: '9999',
  });
  const txnWithNotes = txnFor({
    notes: 'ending in 9999',
    date: '2026-05-05',
    merchantRaw: 'Local Cafe',
    merchantClean: 'Local Cafe',
  });
  const txnNoNotes = txnFor({
    notes: null,
    sourceReference: null,
    date: '2026-05-05',
    merchantRaw: 'Local Cafe',
    merchantClean: 'Local Cafe',
  });
  const withMatchingNotes = scoreAmazonOrderMatch(txnWithNotes, order).confidence;
  const withoutMatchingNotes = scoreAmazonOrderMatch(txnNoNotes, baseOrder).confidence;
  assert.equal(withMatchingNotes - withoutMatchingNotes, 20);
});

test('matcher: payment last4 bonus — both notes and sourceReference null → no bonus regardless of order.paymentLast4', () => {
  const orderWithLast4 = orderFor({
    shipmentDate: '2026-05-03',
    total: '42.00',
    paymentLast4: '1234',
  });
  const orderNoLast4 = orderFor({
    shipmentDate: '2026-05-03',
    total: '42.00',
    paymentLast4: null,
  });
  const txn = txnFor({ notes: null, sourceReference: null, date: '2026-05-05' });
  const a = scoreAmazonOrderMatch(txn, orderWithLast4).confidence;
  const b = scoreAmazonOrderMatch(txn, orderNoLast4).confidence;
  assert.equal(a, b, 'no bonus when txn has no 4-digit text in notes/sourceReference');
});

test('isAmazonLikeMerchant: positive cases', () => {
  assert.equal(isAmazonLikeMerchant('AMZN MKTP CA'), true);
  assert.equal(isAmazonLikeMerchant('Amazon.ca'), true);
  assert.equal(isAmazonLikeMerchant('AMAZON MARKETPLACE'), true);
  assert.equal(isAmazonLikeMerchant('amzn mktp ca *abc'), true);
  assert.equal(isAmazonLikeMerchant('Prime Video'), true);
});

test('isAmazonLikeMerchant: PRIMERICA does NOT match (word boundary on \\bprime\\b)', () => {
  assert.equal(isAmazonLikeMerchant('PRIMERICA INSURANCE'), false);
  assert.equal(isAmazonLikeMerchant('Cafe Primo'), false);
  assert.equal(isAmazonLikeMerchant('Costco Wholesale'), false);
});

// ─── categories: rule precedence ───────────────────────────────────────────

test('categorizeAmazonItem: "coffee notebook" → Office Equipment (Office rule order beats Meals)', () => {
  // Order of rules in src/amazon/categories.ts: Office Equipment first, then
  // Software, then Meals & Groceries. "notebook" is an Office Equipment term
  // and "coffee" is a Meals term — Office wins by rule order.
  assert.equal(categorizeAmazonItem('coffee notebook'), 'Office Equipment');
});

// Note: categorizeAmazonItemsWithAi injection (with mock openaiCaller and
// missing-API-key path) is covered in
// test/integration/importOrchestratorEdgeCases.test.ts because the function's
// first action is a DB findAll for ExternalOrderItem — without a real DB the
// path is unreachable and the test only validates argument plumbing.
