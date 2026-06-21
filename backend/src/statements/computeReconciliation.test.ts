/**
 * Unit tests for the pure reconciliation math helper (#242).
 *
 * Exercises the AC-mandated edge cases:
 *  - Balanced statement (variance == 0).
 *  - Unreconciled / variance != 0 statement.
 *  - Per-account isolation: only same-account transactions go in.
 *  - Refunds: a + then - on the same account net out correctly without
 *    special-case handling.
 *  - Transfers across accounts: the function does not double-count
 *    because the caller filters by account; we assert that behaviour by
 *    only passing one account's leg.
 *  - DECIMAL-as-string input from Sequelize is handled.
 *  - Empty transaction list (e.g. brand-new statement) still produces
 *    the expected closing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeReconciliation,
  isBalanced,
  VARIANCE_TOLERANCE,
} from './computeReconciliation';

test('balanced statement: variance is zero when txns explain opening→closing delta', () => {
  const r = computeReconciliation({
    openingBalance: 1000,
    closingBalance: 850,
    transactions: [
      { amount: -100 },
      { amount: -75 },
      { amount: 25 },
    ],
  });
  assert.equal(r.transactionCount, 3);
  assert.equal(r.transactionTotal, -150);
  assert.equal(r.expectedClosing, 850);
  assert.equal(r.variance, 0);
  assert.equal(isBalanced(r), true);
});

test('unreconciled statement: variance == reportedClosing - expectedClosing', () => {
  // Opening 500, txns sum to -300 → expected closing 200.
  // Statement reports 220 — variance is +20 (statement says we have 20 more
  // than the txn ledger thinks).
  const r = computeReconciliation({
    openingBalance: 500,
    closingBalance: 220,
    transactions: [{ amount: -300 }],
  });
  assert.equal(r.expectedClosing, 200);
  assert.equal(r.variance, 20);
  assert.equal(isBalanced(r), false);
});

test('handles DECIMAL strings from Sequelize', () => {
  const r = computeReconciliation({
    openingBalance: '1000.0000',
    closingBalance: '900.0000',
    transactions: [
      { amount: '-50.0000' },
      { amount: '-50.0000' },
    ],
  });
  assert.equal(r.expectedClosing, 900);
  assert.equal(r.variance, 0);
});

test('refunds: + and - rows net out without special-casing', () => {
  // Original purchase -120, refund +120.
  const r = computeReconciliation({
    openingBalance: 1000,
    closingBalance: 1000,
    transactions: [
      { amount: -120 },
      { amount: 120 },
    ],
  });
  assert.equal(r.expectedClosing, 1000);
  assert.equal(r.variance, 0);
});

test('internal transfers across accounts: only the leg in this account contributes', () => {
  // Statement is for Chequing. A $500 transfer to Savings shows up as one
  // -500 row HERE; the matching +500 row on Savings is filtered out by the
  // caller (different account). The function must not double-count.
  const r = computeReconciliation({
    openingBalance: 2000,
    closingBalance: 1500,
    transactions: [{ amount: -500 }],
  });
  assert.equal(r.expectedClosing, 1500);
  assert.equal(r.variance, 0);
});

test('empty transaction list returns expectedClosing = opening', () => {
  const r = computeReconciliation({
    openingBalance: 1234.5,
    closingBalance: 1234.5,
    transactions: [],
  });
  assert.equal(r.transactionCount, 0);
  assert.equal(r.expectedClosing, 1234.5);
  assert.equal(r.variance, 0);
});

test('handles NaN/null amounts as zero (defensive)', () => {
  const r = computeReconciliation({
    openingBalance: 100,
    closingBalance: 100,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactions: [{ amount: null as any }, { amount: 'not a number' }],
  });
  assert.equal(r.transactionTotal, 0);
  assert.equal(r.expectedClosing, 100);
  assert.equal(r.variance, 0);
});

test('isBalanced respects the 1-cent tolerance', () => {
  const slightlyOff = computeReconciliation({
    openingBalance: 100,
    closingBalance: 100.005,
    transactions: [],
  });
  assert.ok(Math.abs(slightlyOff.variance) <= VARIANCE_TOLERANCE);
  assert.equal(isBalanced(slightlyOff), true);

  const significantlyOff = computeReconciliation({
    openingBalance: 100,
    closingBalance: 100.5,
    transactions: [],
  });
  assert.equal(isBalanced(significantlyOff), false);
});

test('rounding to 4 decimals matches DECIMAL(18,4) storage precision', () => {
  const r = computeReconciliation({
    openingBalance: 0.0001,
    closingBalance: 0.0001,
    transactions: [
      { amount: 1 / 3 },
      { amount: -1 / 3 },
    ],
  });
  // 1/3 - 1/3 in IEEE-754 is not exactly 0; round4 must clean it up.
  assert.equal(r.expectedClosing, 0.0001);
  assert.equal(r.variance, 0);
});
