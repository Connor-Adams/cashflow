import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRecurring,
  type RecurringInputTxn,
} from './recurring';

function charge(
  merchant: string,
  amount: number,
  date: string,
  currency = 'CAD',
  category: string | null = null
): RecurringInputTxn {
  return { merchant, amount: -Math.abs(amount), date, currency, category };
}

test('detectRecurring picks up four monthly charges as monthly cadence', () => {
  const txns: RecurringInputTxn[] = [
    charge('Netflix', 15.99, '2026-01-05', 'CAD', 'Streaming'),
    charge('Netflix', 15.99, '2026-02-05', 'CAD', 'Streaming'),
    charge('Netflix', 15.99, '2026-03-05', 'CAD', 'Streaming'),
    charge('Netflix', 15.99, '2026-04-05', 'CAD', 'Streaming'),
  ];
  const items = detectRecurring(txns);
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.merchant, 'Netflix');
  assert.equal(item.currency, 'CAD');
  assert.equal(item.cadence, 'monthly');
  assert.equal(item.occurrences, 4);
  assert.ok(Math.abs(item.avgAmount - 15.99) < 1e-6);
  assert.equal(item.amountStability, 1);
  assert.equal(item.lastSeen, '2026-04-05');
  assert.equal(item.category, 'Streaming');
  assert.ok(item.nextExpected > item.lastSeen);
});

test('detectRecurring drops merchants with fewer than minOccurrences charges', () => {
  // Two charges spaced ~monthly: under the default minOccurrences (3) the
  // merchant gets dropped, but if a caller asked for minOccurrences=2 the
  // detector would surface it.
  const txns: RecurringInputTxn[] = [
    charge('Spotify', 9.99, '2026-02-15'),
    charge('Spotify', 9.99, '2026-03-15'),
  ];
  assert.equal(detectRecurring(txns).length, 0);
  assert.equal(detectRecurring(txns, { minOccurrences: 2 }).length, 1);
  // A single charge can never be recurring.
  const single: RecurringInputTxn[] = [charge('Spotify', 9.99, '2026-02-15')];
  assert.equal(detectRecurring(single, { minOccurrences: 2 }).length, 0);
});

test('detectRecurring drops irregular cadences', () => {
  // The algorithm classifies cadence on the mean gap alone. Pick dates
  // whose mean gap lands outside both the monthly [25, 35] and weekly
  // [6, 8] bands so the merchant gets dropped.
  const irregular: RecurringInputTxn[] = [
    charge('Random LLC', 12, '2026-01-01'),
    charge('Random LLC', 12, '2026-01-06'), // +5
    charge('Random LLC', 12, '2026-02-19'), // +44
    charge('Random LLC', 12, '2026-03-05'), // +14
  ];
  // Mean gap = (5 + 44 + 14) / 3 ~= 21 days — outside [25, 35] and [6, 8].
  assert.equal(detectRecurring(irregular).length, 0);
});

test('detectRecurring keeps two currencies for the same merchant separate', () => {
  const txns: RecurringInputTxn[] = [
    charge('AcmeCloud', 20, '2026-01-10', 'CAD'),
    charge('AcmeCloud', 20, '2026-02-10', 'CAD'),
    charge('AcmeCloud', 20, '2026-03-10', 'CAD'),
    charge('AcmeCloud', 15, '2026-01-12', 'USD'),
    charge('AcmeCloud', 15, '2026-02-12', 'USD'),
    charge('AcmeCloud', 15, '2026-03-12', 'USD'),
  ];
  const items = detectRecurring(txns);
  assert.equal(items.length, 2);
  const cad = items.find((i) => i.currency === 'CAD');
  const usd = items.find((i) => i.currency === 'USD');
  assert.ok(cad, 'expected a CAD item');
  assert.ok(usd, 'expected a USD item');
  assert.equal(cad!.merchant, 'AcmeCloud');
  assert.equal(usd!.merchant, 'AcmeCloud');
  // Sorted by avgAmount desc — CAD (20) should come before USD (15).
  assert.equal(items[0].currency, 'CAD');
});

test('detectRecurring drops rows with empty merchants and ignores them', () => {
  // The route handler is responsible for excluding payment/transfer/refund
  // rows before calling detectRecurring. This test confirms the detector
  // only acts on what it is given: a sparse input with empty merchant
  // strings should produce no items.
  const txns: RecurringInputTxn[] = [
    charge('', 50, '2026-01-01'),
    charge('   ', 50, '2026-02-01'),
    { merchant: null, amount: -50, date: '2026-03-01', currency: 'CAD', category: null },
  ];
  assert.equal(detectRecurring(txns).length, 0);
});

test('detectRecurring picks up weekly cadence and groups regardless of casing', () => {
  // Same merchant spelled with different casing should group together.
  const txns: RecurringInputTxn[] = [
    charge('CoffeeBar', 4.5, '2026-01-02'),
    charge('coffeebar', 4.5, '2026-01-09'),
    charge('COFFEEBAR', 4.5, '2026-01-16'),
    charge('CoffeeBar', 4.5, '2026-01-23'),
  ];
  const items = detectRecurring(txns);
  assert.equal(items.length, 1);
  assert.equal(items[0].cadence, 'weekly');
  assert.equal(items[0].occurrences, 4);
});

test('detectRecurring sets category to null when the group is mixed', () => {
  const txns: RecurringInputTxn[] = [
    charge('MixedMerchant', 30, '2026-01-05', 'CAD', 'Groceries'),
    charge('MixedMerchant', 30, '2026-02-05', 'CAD', 'Dining'),
    charge('MixedMerchant', 30, '2026-03-05', 'CAD', 'Travel'),
  ];
  const items = detectRecurring(txns);
  assert.equal(items.length, 1);
  assert.equal(items[0].category, null);
});

test('detectRecurring amountStability drops when amounts vary widely', () => {
  const txns: RecurringInputTxn[] = [
    charge('FluxBills', 10, '2026-01-05'),
    charge('FluxBills', 50, '2026-02-05'),
    charge('FluxBills', 90, '2026-03-05'),
  ];
  const [item] = detectRecurring(txns);
  assert.ok(item, 'expected an item');
  // stdDev / mean here is ~0.54, so stability should be ~0.46.
  assert.ok(item.amountStability < 0.6);
  assert.ok(item.amountStability >= 0);
});
