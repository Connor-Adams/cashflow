/**
 * Re-typing historical card payments.
 *
 * `detectTypeStage` now recognizes a pre-authorized debit that names a card
 * network as a payment, but rows imported before that are still stored with
 * whatever the old rules produced. Prod holds 38 of them on a single narrative,
 * "Pre-authorized Debit to AMEX BILL PYMT", typed `transfer` — while the two
 * rows the deposit cleanup inserted after the fix, same narrative, are typed
 * `payment`. Same event, two answers, split by import date.
 *
 * The predicate is driven by the detector itself rather than a regex of its
 * own, so the backfill cannot drift from what the import path does. It only
 * ever promotes TO `payment`, and only when the detector is certain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetypeAsPayment } from './retypeCardPayments';

test('promotes the historical AMEX pre-authorized debit', () => {
  assert.equal(
    shouldRetypeAsPayment({
      merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
      merchantClean: 'Pre-authorized Debit to AMEX BILL PYMT',
      amount: -2959.34,
      txnType: 'transfer',
    }),
    true,
  );
});

test('leaves a row that is already a payment alone', () => {
  assert.equal(
    shouldRetypeAsPayment({
      merchantRaw: 'MISC PAYMENT AMEX BILL PYMT',
      merchantClean: 'MISC PAYMENT AMEX BILL PYMT',
      amount: -1200,
      txnType: 'payment',
    }),
    false,
  );
});

test('leaves a utility pre-authorized debit as spend', () => {
  // No card-network token → not a card payment. This is the precision line the
  // detector's rule is built around, and the backfill must respect it.
  assert.equal(
    shouldRetypeAsPayment({
      merchantRaw: 'Pre-authorized Debit to ROGERS',
      merchantClean: 'Pre-authorized Debit to ROGERS',
      amount: -95.4,
      txnType: 'transfer',
    }),
    false,
  );
});

test('leaves a debit-card purchase alone even though it names a network', () => {
  // Real prod row: "VISA DEBIT PURCHASE - 1253 FTX BLOCKFOLIO" is spend.
  assert.equal(
    shouldRetypeAsPayment({
      merchantRaw: 'VISA DEBIT PURCHASE - 1253 FTX BLOCKFOLIO',
      merchantClean: 'VISA DEBIT PURCHASE - 1253 FTX BLOCKFOLIO',
      amount: -250,
      txnType: 'purchase',
    }),
    false,
  );
});

test('leaves a genuine transfer alone', () => {
  assert.equal(
    shouldRetypeAsPayment({
      merchantRaw: 'Interac e-Transfer® Received from ZHENYUN GAO',
      merchantClean: 'Interac e-Transfer Received from ZHENYUN GAO',
      amount: 150,
      txnType: 'transfer',
    }),
    false,
  );
});

test('leaves a reversal as a refund', () => {
  // Real prod row. The refund rule outranks every payment rule and must keep
  // doing so — a reversed bill payment is money coming back, not going out.
  assert.equal(
    shouldRetypeAsPayment({
      merchantRaw: 'BILL PAYMENT REVERSAL - 7009 CAPITAL ONE M/C',
      merchantClean: 'BILL PAYMENT REVERSAL - 7009 CAPITAL ONE M/C',
      amount: 300,
      txnType: 'refund',
    }),
    false,
  );
});

test('never demotes — a row the detector is unsure about is left as it is', () => {
  // "Withdrawal" carries no card cue, so the detector has nothing certain to
  // say. The backfill only ever promotes to payment; it must not rewrite
  // anything on a low-confidence read.
  assert.equal(
    shouldRetypeAsPayment({
      merchantRaw: 'Withdrawal',
      merchantClean: 'Withdrawal',
      amount: -250,
      txnType: 'transfer',
    }),
    false,
  );
});
