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
  // with txnType='unknown'. The /\bpayment\b/ pattern in PAYMENT_PATTERNS
  // fires correctly, routing these to 'payment'.
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

test('classifyPositiveFlow: bare "credit" without a refund/payment keyword routes to skip (no keyword match)', () => {
  // "COURTESY CREDIT" and "MERCHANT CREDIT" contain "credit" but no
  // CREDIT_PATTERNS keyword (statement credit requires the full phrase) and no
  // PAYMENT_PATTERNS keyword. They fall through to the default, which is 'skip'
  // — unknown positive inflows contribute to nothing rather than deflating net
  // spend as false credits.
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'COURTESY CREDIT' }),
    'skip'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'MERCHANT CREDIT' }),
    'skip'
  );
});

test('classifyPositiveFlow defaults to skip for unknown deposits', () => {
  // Unrecognized positive deposits (business payments, self-transfers, ATM
  // deposits, WS contributions) must not deflate net spend by landing in
  // totalCredits. The default is 'skip' so they contribute to nothing.
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'CDG LABS INC' }),
    'skip'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'ATM DEPOSIT - KF470333' }),
    'skip'
  );
  assert.equal(
    classifyPositiveFlow({ merchantRaw: 'EI CANADA' }),
    'skip'
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
  // No refund/payment keyword: an unsignaled positive is NOT assumed to be a
  // refund-against-spend. It routes to 'skip' (contributes to nothing) rather
  // than 'credit'. Both classifyPositiveFlow and classifyPositiveAmount now
  // share this default.
  assert.equal(
    classifyPositiveAmount({ txnType: 'fee', merchantRaw: 'annual fee waiver' }),
    'skip'
  );
});

test('classifyPositiveAmount: unsignaled positive inflow routes to skip, not credit', () => {
  // Regression for the ~$108k net-spend bug: positive deposits / transfers /
  // benefits / principal movements carried txnType=unknown and, with no
  // refund/payment keyword, defaulted to 'credit' — wrongly subtracting from
  // net spend (= totalSpend - totalCredits). They must route to 'skip'.
  for (const merchantRaw of [
    'ATM DEPOSIT - KF470333',
    'WWW PMT TIN0-03100 (5,000.00) Principal',
    'Cash correction',
    'EI CANADA',
    'Deposit (executed at 2026-03-17)',
  ]) {
    assert.equal(
      classifyPositiveAmount({ txnType: 'unknown', merchantRaw }),
      'skip',
      `${merchantRaw} should be skip, not credit`
    );
  }
});

test('classifyPositiveAmount: explicit refund/payment keyword still wins over the skip default', () => {
  // The skip default must NOT swallow genuine refunds/credits that carry a
  // CREDIT_PATTERNS keyword, nor statement payments matching PAYMENT_PATTERNS.
  assert.equal(
    classifyPositiveAmount({ txnType: 'unknown', merchantRaw: 'MERCHANDISE REFUND' }),
    'credit'
  );
  assert.equal(
    classifyPositiveAmount({ txnType: 'unknown', merchantRaw: 'STATEMENT CREDIT' }),
    'credit'
  );
  assert.equal(
    classifyPositiveAmount({ txnType: 'unknown', merchantRaw: 'AUTOPAY THANK YOU' }),
    'payment'
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
