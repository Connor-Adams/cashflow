/**
 * Unit tests for the pure `isNonCategorizableRow` predicate that drives the
 * AI insights "no_category_count" cleanup queue.
 *
 * Regression: positive income (txnType='income') classifies as 'credit' via
 * classifyPositiveAmount (NOT skip/payment), so a null-category paycheck used
 * to be counted as a cleanup target — paychecks aren't spend rows awaiting a
 * category. The predicate must peel income specifically WITHOUT peeling other
 * NON_SPEND positive flows (refund/reward stay categorizable 'credit' rows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNonCategorizableRow } from './insights';

test('positive income is non-categorizable (not a cleanup target)', () => {
  assert.equal(
    isNonCategorizableRow({
      amount: 3200,
      txnType: 'income',
      accountType: 'depository',
      merchantRaw: 'ACME CORP PAYROLL',
      merchantClean: 'Acme Corp',
      category: null,
    }),
    true,
  );
});

test('negative ordinary spend with no category IS a cleanup target', () => {
  assert.equal(
    isNonCategorizableRow({
      amount: -42.5,
      txnType: 'purchase',
      accountType: 'depository',
      merchantRaw: 'SOME STORE',
      merchantClean: 'Some Store',
      category: null,
    }),
    false,
  );
});

test('negative money-movement leg (transfer) is non-categorizable', () => {
  assert.equal(
    isNonCategorizableRow({
      amount: -500,
      txnType: 'transfer',
      accountType: 'depository',
      category: null,
    }),
    true,
  );
});

test('positive statement payment is non-categorizable', () => {
  assert.equal(
    isNonCategorizableRow({
      amount: 250,
      txnType: 'payment',
      accountType: 'credit',
      category: null,
    }),
    true,
  );
});

test('positive refund stays categorizable (income peel must NOT widen to all NON_SPEND types)', () => {
  assert.equal(
    isNonCategorizableRow({
      amount: 30,
      txnType: 'refund',
      accountType: 'credit',
      merchantRaw: 'MERCHANDISE REFUND',
      merchantClean: 'Some Store',
      category: null,
    }),
    false,
  );
});

test('positive reward stays categorizable', () => {
  assert.equal(
    isNonCategorizableRow({
      amount: 15,
      txnType: 'reward',
      accountType: 'credit',
      category: null,
    }),
    false,
  );
});
