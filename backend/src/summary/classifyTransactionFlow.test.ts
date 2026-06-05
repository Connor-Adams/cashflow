import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPositiveAmount,
  classifyPositiveFlow,
  isNonCategorical,
  isNonSpend,
} from './classifyTransactionFlow';

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

test('classifyPositiveFlow: refund keyword beats payment keyword when both present', () => {
  // "PAYMENT REVERSAL" contains both /\bpayment\b/ and /\breversal\b/.
  // The reversal signal is more specific (it explicitly means money flowing
  // BACK to the cardholder) and must win.
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'PAYMENT REVERSAL ACH-12345' }),
    'credit'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'BILL PAYMENT REFUND' }),
    'credit'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'TRANSFER ADJUSTMENT' }),
    'credit'
  );
});

test('classifyPositiveFlow: payment keyword without refund signal still routes to payment', () => {
  // Regression guard: the most common payment strings must not flip to credit
  // after the precedence swap. None of these contain CREDIT_PATTERNS keywords.
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'AUTOPAY THANK YOU' }),
    'payment'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'PRE-AUTHORIZED PAYMENT' }),
    'payment'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'ACH ELECTRONIC PAYMENT' }),
    'payment'
  );
});

test('classifyPositiveFlow: "CREDIT CARD PAYMENT" routes to payment, not credit', () => {
  // Regression guard from the Task 2 code review. detectTypeStage does not
  // catch bare "CREDIT CARD PAYMENT" as txnType='payment' (its regex only
  // matches "online payment|payment received|payment thank you|autopay|
  // statement credit"), so this string falls through to classifyPositiveFlow
  // with txnType='unknown'. A bare /\bcredit\b/ in CREDIT_PATTERNS would
  // over-match here and mis-route a statement payment to 'credit'. The fix
  // is to omit the bare pattern; the function's default is already 'credit'
  // so refund-intent strings like "COURTESY CREDIT" still land correctly.
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'CREDIT CARD PAYMENT' }),
    'payment'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'VISA CREDIT CARD PAYMENT' }),
    'payment'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'CREDIT CARD BILL PAYMENT' }),
    'payment'
  );
});

test('classifyPositiveFlow: bare "credit" without a payment keyword still routes to credit (via default)', () => {
  // Defense for the deleted /\bcredit\b/ pattern: refund-intent strings that
  // contain only "credit" with no payment keyword (e.g. courtesy adjustments
  // a bank labels just "CREDIT") still land on the default return of 'credit'.
  // No CREDIT_PATTERNS match needed because nothing in PAYMENT_PATTERNS fires
  // either.
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'COURTESY CREDIT' }),
    'credit'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'MERCHANT CREDIT' }),
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
