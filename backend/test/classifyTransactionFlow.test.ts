import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPositiveAmount,
  classifyPositiveFlow,
  isNonCategorical,
  isNonSpend,
} from '../src/summary/classifyTransactionFlow';

test('classifyPositiveFlow marks payment-like rows as payments', () => {
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'ONLINE PAYMENT THANK YOU' }),
    'payment'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'PRE-AUTHORIZED PAYMENT' }),
    'payment'
  );
});

test('classifyPositiveFlow keeps refund-like rows as credits', () => {
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'MERCHANDISE REFUND' }),
    'credit'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'STATEMENT CREDIT' }),
    'credit'
  );
});

// classifyPositiveAmount is the authoritative router for positive-amount rows
// in dashboard / monthly / insights aggregations. It uses txnType first
// (set by the enricher with intent) and falls back to merchant-regex.

test('classifyPositiveAmount: txnType=transfer routes to skip (incoming transfer is not consumption, refund, or income)', () => {
  assert.equal(
    classifyPositiveAmount({ txnType: 'transfer', merchantRaw: 'AFT_IN Direct deposit' }),
    'skip'
  );
});

test('classifyPositiveAmount: txnType=investment routes to skip (SELL proceeds)', () => {
  assert.equal(
    classifyPositiveAmount({ txnType: 'investment', merchantRaw: 'SELL XEQT' }),
    'skip'
  );
});

test('classifyPositiveAmount: txnType=dividend routes to skip (income-like, not credit)', () => {
  assert.equal(
    classifyPositiveAmount({ txnType: 'dividend', merchantRaw: 'DIV VFV cash distribution' }),
    'skip'
  );
});

test('classifyPositiveAmount: investment account routes to skip regardless of txnType', () => {
  assert.equal(
    classifyPositiveAmount({
      txnType: 'unknown',
      accountType: 'investment',
      merchantRaw: 'mystery inflow',
    }),
    'skip'
  );
});

test('classifyPositiveAmount: txnType=payment routes to payment even when merchant regex misses', () => {
  assert.equal(
    classifyPositiveAmount({ txnType: 'payment', merchantRaw: 'CC AUTOPAY OBSCURE-NAME-123' }),
    'payment'
  );
  assert.equal(
    classifyPositiveAmount({ txnType: 'payment', merchantRaw: 'Unrelated text' }),
    'payment'
  );
});

test('classifyPositiveAmount: txnType=refund routes to credit', () => {
  assert.equal(
    classifyPositiveAmount({ txnType: 'refund', merchantRaw: 'AMAZON.CA' }),
    'credit'
  );
});

test('classifyPositiveAmount: txnType=reward routes to credit', () => {
  assert.equal(
    classifyPositiveAmount({ txnType: 'reward', merchantRaw: 'POINTS REDEMPTION' }),
    'credit'
  );
});

test('classifyPositiveAmount: txnType=income routes to credit', () => {
  assert.equal(
    classifyPositiveAmount({ txnType: 'income', merchantRaw: 'EMPLOYER PAYROLL' }),
    'credit'
  );
});

test('classifyPositiveAmount: missing txnType falls back to merchant regex', () => {
  assert.equal(
    classifyPositiveAmount({ txnType: null, merchantRaw: 'ONLINE PAYMENT THANK YOU' }),
    'payment'
  );
  assert.equal(
    classifyPositiveAmount({ txnType: 'purchase', merchantRaw: 'MERCHANDISE REFUND' }),
    'credit'
  );
  assert.equal(
    classifyPositiveAmount({ txnType: 'fee', merchantRaw: 'annual fee waiver' }),
    'credit'
  );
});

test('classifyPositiveAmount: regression — AFT_IN-style positive transfer with no payment keyword does NOT leak to credit', () => {
  // The bug we are fixing: pre-fix, this row landed in headline totalCredits
  // because classifyPositiveFlow defaulted to 'credit' when no PAYMENT_PATTERNS
  // matched. With classifyPositiveAmount honoring txnType, it routes to 'skip'.
  assert.equal(
    classifyPositiveAmount({
      txnType: 'transfer',
      merchantRaw: 'AFT_IN',
      merchantClean: 'Direct deposit from EMPLOYER',
    }),
    'skip'
  );
});

test('isNonSpend: NON_SPEND_TXN_TYPES are excluded', () => {
  for (const t of ['transfer', 'investment', 'dividend', 'payment', 'refund', 'reward', 'income']) {
    assert.equal(isNonSpend(t, null), true, `${t} should be non-spend`);
  }
  assert.equal(isNonSpend('purchase', null), false);
  assert.equal(isNonSpend(null, null), false);
});

test('isNonSpend: investment account is non-spend regardless of txnType', () => {
  assert.equal(isNonSpend('purchase', 'investment'), true);
  assert.equal(isNonSpend(null, 'investment'), true);
});

test('isNonCategorical: only transfer/investment/dividend (refunds stay in)', () => {
  for (const t of ['transfer', 'investment', 'dividend']) {
    assert.equal(isNonCategorical(t, null), true);
  }
  for (const t of ['refund', 'reward', 'income', 'payment', 'purchase']) {
    assert.equal(isNonCategorical(t, null), false, `${t} should be categorical`);
  }
});

test('isNonCategorical: investment account is non-categorical (belt-and-suspenders)', () => {
  assert.equal(isNonCategorical('purchase', 'investment'), true);
});
