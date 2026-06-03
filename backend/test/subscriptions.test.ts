/**
 * Unit tests for the pure subscription helpers (Cashflow #205).
 *
 * Integration coverage (HTTP routes, DB persistence, household isolation)
 * lives in test/integration/subscriptions.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annualizeCost,
  mergeDetectionWithExisting,
  normalizeMerchantName,
  type ExistingSubscriptionRow,
} from '../src/subscriptions/detect';
import type { RecurringItem } from '../src/routes/recurring';

function item(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    merchant: 'Netflix',
    currency: 'CAD',
    cadence: 'monthly',
    occurrences: 4,
    avgAmount: 15.99,
    amountStability: 1,
    lastSeen: '2026-05-05',
    nextExpected: '2026-06-05',
    category: 'Streaming',
    ...overrides,
  };
}

test('annualizeCost multiplies monthly amounts by 12', () => {
  assert.equal(annualizeCost(15.99, 'monthly'), 15.99 * 12);
});

test('annualizeCost multiplies weekly amounts by 52', () => {
  assert.equal(annualizeCost(8, 'weekly'), 8 * 52);
});

test('annualizeCost takes the absolute value of negative charges', () => {
  // Charges arrive as negative numbers per the codebase convention.
  assert.equal(annualizeCost(-15.99, 'monthly'), 15.99 * 12);
});

test('normalizeMerchantName lowercases and trims', () => {
  assert.equal(normalizeMerchantName('  Netflix  '), 'netflix');
  assert.equal(normalizeMerchantName('SPOTIFY USA'), 'spotify usa');
});

test('mergeDetectionWithExisting inserts when no row matches', () => {
  const ops = mergeDetectionWithExisting([item()], []);
  assert.equal(ops.length, 1);
  const [op] = ops;
  assert.equal(op.kind, 'insert');
  if (op.kind !== 'insert') return; // type guard for TS
  assert.equal(op.merchantName, 'Netflix');
  assert.equal(op.normalizedName, 'netflix');
  assert.equal(op.currency, 'CAD');
  assert.equal(op.amount, '15.9900');
  assert.equal(op.status, 'active');
  assert.equal(op.annualizedCost, (15.99 * 12).toFixed(4));
});

test('mergeDetectionWithExisting updates when a row matches normalizedName+currency', () => {
  const existing: ExistingSubscriptionRow[] = [
    {
      id: 42,
      normalizedName: 'netflix',
      currency: 'CAD',
      amount: '15.9900',
      status: 'active',
      cancellationUrl: null,
      notes: null,
    },
  ];
  const ops = mergeDetectionWithExisting([item({ avgAmount: 17.99 })], existing);
  assert.equal(ops.length, 1);
  const [op] = ops;
  assert.equal(op.kind, 'update');
  if (op.kind !== 'update') return;
  assert.equal(op.id, 42);
  assert.equal(op.patch.amount, '17.9900');
});

test('mergeDetectionWithExisting matches even if persisted status is cancelled or ignored', () => {
  // We never DROP merge candidates based on persisted status — the user
  // may have marked Netflix "ignored" but is now seeing it again because
  // they re-subscribed. The detector resurfaces it; the user's status
  // sticks until they change it.
  const existing: ExistingSubscriptionRow[] = [
    {
      id: 99,
      normalizedName: 'netflix',
      currency: 'CAD',
      amount: '15.9900',
      status: 'ignored',
      cancellationUrl: null,
      notes: null,
    },
  ];
  const ops = mergeDetectionWithExisting([item()], existing);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'update');
});

test('mergeDetectionWithExisting keys on currency so the same merchant in two currencies stays distinct', () => {
  const existing: ExistingSubscriptionRow[] = [
    {
      id: 1,
      normalizedName: 'acmecloud',
      currency: 'CAD',
      amount: '20.0000',
      status: 'active',
      cancellationUrl: null,
      notes: null,
    },
  ];
  const ops = mergeDetectionWithExisting(
    [
      item({ merchant: 'AcmeCloud', currency: 'CAD', avgAmount: 20 }),
      item({ merchant: 'AcmeCloud', currency: 'USD', avgAmount: 15 }),
    ],
    existing,
  );
  // CAD update, USD insert.
  assert.equal(ops.length, 2);
  assert.equal(ops[0].kind, 'update');
  assert.equal(ops[1].kind, 'insert');
});

test('mergeDetectionWithExisting carries category from detection (no preservation of stale category)', () => {
  // Category is detection-derived and reflects the latest categorization.
  const existing: ExistingSubscriptionRow[] = [
    {
      id: 1,
      normalizedName: 'netflix',
      currency: 'CAD',
      amount: '15.9900',
      status: 'active',
      cancellationUrl: 'https://netflix.com/cancel',
      notes: 'old category was Misc',
    },
  ];
  const ops = mergeDetectionWithExisting(
    [item({ category: 'Streaming' })],
    existing,
  );
  if (ops[0].kind !== 'update') {
    assert.fail('expected update op');
    return;
  }
  assert.equal(ops[0].patch.category, 'Streaming');
});
