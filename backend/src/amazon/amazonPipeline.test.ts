/**
 * Unit tests for the Amazon pipeline modules.
 * Pure functions only — no DB, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amazonOrderDedupeKey,
  normalizeAmazonOrder,
  normalizeTitle,
} from './normalizeAmazonOrder';
import { scoreAmazonOrderMatch } from './matcher';
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
  const localScore = scoreAmazonOrderMatch(local, order, null).confidence;
  const amznScore = scoreAmazonOrderMatch(amzn, order, null).confidence;
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
    null,
  ).confidence;
  assert.equal(gap3, 75);

  // gap=6 → outside 0-5 window AND within 10 days → no date bonus, no penalty → just +50 amount = 50
  const gap6 = scoreAmazonOrderMatch(
    txnFor({ ...merchantNoBonus, date: '2026-05-11' }),
    order,
    null,
  ).confidence;
  assert.equal(gap6, 50);

  // gap=11 → over 10 days → -15 penalty → 50 - 15 = 35
  const gap11 = scoreAmazonOrderMatch(
    txnFor({ ...merchantNoBonus, date: '2026-05-16' }),
    order,
    null,
  ).confidence;
  assert.equal(gap11, 35);
});

test('matcher: ambiguous orders — both score >=70 → both above-threshold', () => {
  // amount within 0.5 (+50) + date 0-5 (+25) → 75, two candidates both qualify.
  const orderA = orderFor({ shipmentDate: '2026-05-03', total: '42.00' });
  const orderB = orderFor({ shipmentDate: '2026-05-04', total: '42.25' });
  const txn = txnFor({ date: '2026-05-05', merchantRaw: 'Local Cafe', merchantClean: 'Local Cafe' });
  const scoreA = scoreAmazonOrderMatch(txn, orderA, null).confidence;
  const scoreB = scoreAmazonOrderMatch(txn, orderB, null).confidence;
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
  const scoreA = scoreAmazonOrderMatch(txn, orderA, null).confidence;
  const scoreB = scoreAmazonOrderMatch(txn, orderB, null).confidence;
  assert.equal(scoreA, 65);
  assert.equal(scoreB, 65);
});

test('matcher: payment last4 bonus — account-derived txnLast4 "1234" + paymentLast4="1234" → +20', () => {
  // Use a >$0.50 amount delta (+35) and a non-Amazon merchant so the base
  // score stays well below the 100 cap and the +20 bonus is observable.
  // txnLast4 is now the account-derived third parameter, not text scraped
  // from notes/sourceReference (that scrape matched 0 of 111 prod txns and
  // has been deleted — see cardOwnership.resolveAccountLast4).
  const baseOrder = orderFor({ shipmentDate: '2026-05-03', total: '40.50' });
  const orderWithLast4 = orderFor({
    shipmentDate: '2026-05-03',
    total: '40.50',
    paymentLast4: '1234',
  });
  const txn = txnFor({
    date: '2026-05-05',
    merchantRaw: 'Local Cafe',
    merchantClean: 'Local Cafe',
  });

  const noBonus = scoreAmazonOrderMatch(txn, baseOrder, '1234').confidence;
  const withBonus = scoreAmazonOrderMatch(txn, orderWithLast4, '1234').confidence;
  assert.equal(withBonus - noBonus, 20);
});

test('matcher: payment last4 bonus — account-derived txnLast4 "9999" matches paymentLast4=9999', () => {
  const baseOrder = orderFor({
    shipmentDate: '2026-05-03',
    total: '40.50',
  });
  const order = orderFor({
    shipmentDate: '2026-05-03',
    total: '40.50',
    paymentLast4: '9999',
  });
  const txn = txnFor({
    date: '2026-05-05',
    merchantRaw: 'Local Cafe',
    merchantClean: 'Local Cafe',
  });
  const withMatchingLast4 = scoreAmazonOrderMatch(txn, order, '9999').confidence;
  const withoutMatchingLast4 = scoreAmazonOrderMatch(txn, baseOrder, '9999').confidence;
  assert.equal(withMatchingLast4 - withoutMatchingLast4, 20);
});

test('matcher: payment last4 bonus — null txnLast4 → no bonus regardless of order.paymentLast4', () => {
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
  const txn = txnFor({ date: '2026-05-05' });
  const a = scoreAmazonOrderMatch(txn, orderWithLast4, null).confidence;
  const b = scoreAmazonOrderMatch(txn, orderNoLast4, null).confidence;
  assert.equal(a, b, 'no bonus when txnLast4 is null, regardless of order.paymentLast4');
});

// isAmazonLikeMerchant coverage moved to ./merchant.test.ts alongside its
// definition in ./merchant.ts.

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
