import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wsPdfCodeToActivity,
  WS_PDF_SKIP_CODES,
  wsPdfCashCodeToTxnType,
} from './wealthsimpleActivityCodes';

test('aligns with TX_TO_ACTIVITY for shared codes', () => {
  assert.equal(wsPdfCodeToActivity('BUY'), 'buy');
  assert.equal(wsPdfCodeToActivity('SELL'), 'sell');
  assert.equal(wsPdfCodeToActivity('DIV'), 'dividend');
  assert.equal(wsPdfCodeToActivity('INT'), 'interest');
  assert.equal(wsPdfCodeToActivity('FPLINT'), 'interest');
  assert.equal(wsPdfCodeToActivity('FEE'), 'fee');
  assert.equal(wsPdfCodeToActivity('CONT'), 'transfer');
  assert.equal(wsPdfCodeToActivity('CRYPTORWD'), 'staking_reward');
});

test('maps cash-movement / transfer codes', () => {
  assert.equal(wsPdfCodeToActivity('DEP'), 'cash_movement');
  assert.equal(wsPdfCodeToActivity('WD'), 'cash_movement');
  assert.equal(wsPdfCodeToActivity('TRFIN'), 'transfer_in');
  assert.equal(wsPdfCodeToActivity('TRFOUT'), 'transfer_out');
  assert.equal(wsPdfCodeToActivity('ROC'), 'return_of_capital');
});

test('case-insensitive', () => {
  assert.equal(wsPdfCodeToActivity('buy'), 'buy');
  assert.equal(wsPdfCodeToActivity('  Div '), 'dividend');
});

test('zero-cash stock-lending codes are flagged skip, not misclassified', () => {
  assert.ok(WS_PDF_SKIP_CODES.has('LOAN'));
  assert.ok(WS_PDF_SKIP_CODES.has('RECALL'));
  assert.equal(wsPdfCodeToActivity('LOAN'), null);
});

test('unknown code returns null', () => {
  assert.equal(wsPdfCodeToActivity('ZZZ'), null);
});

test('DCTFEE is a cash-account code, not an InvestmentActivity', () => {
  // wsPdfCodeToActivity must return null so the brokerage parser's
  // CASH_TXN_CODES branch routes debit-card fees to the cash ledger — a MAP
  // entry would intercept them as investment fee activities.
  assert.equal(wsPdfCodeToActivity('DCTFEE'), null);
});

// ---------------------------------------------------------------------------
// Cash-code → TxnType (overrideTxnType source for the brokerage cash branch).
// ---------------------------------------------------------------------------

test('wsPdfCashCodeToTxnType maps the cash-account codes to TxnType', () => {
  assert.equal(wsPdfCashCodeToTxnType('SPEND'), 'purchase');
  assert.equal(wsPdfCashCodeToTxnType('OBP'), 'payment');
  assert.equal(wsPdfCashCodeToTxnType('CASHBACK'), 'reward');
  assert.equal(wsPdfCashCodeToTxnType('GIVEAWAY'), 'reward');
  assert.equal(wsPdfCashCodeToTxnType('DCTFEE'), 'fee');
  assert.equal(wsPdfCashCodeToTxnType('AFT_OUT'), 'transfer');
  assert.equal(wsPdfCashCodeToTxnType('AFT_IN'), 'transfer');
  assert.equal(wsPdfCashCodeToTxnType('E_TRFIN'), 'transfer');
  assert.equal(wsPdfCashCodeToTxnType('EFT'), 'transfer');
});

test('wsPdfCashCodeToTxnType is case-insensitive and trims', () => {
  assert.equal(wsPdfCashCodeToTxnType('  spend '), 'purchase');
  assert.equal(wsPdfCashCodeToTxnType('aft_out'), 'transfer');
});

test('wsPdfCashCodeToTxnType returns null for unknown/empty', () => {
  assert.equal(wsPdfCashCodeToTxnType('ZZZ'), null);
  assert.equal(wsPdfCashCodeToTxnType(null), null);
  assert.equal(wsPdfCashCodeToTxnType(undefined), null);
  assert.equal(wsPdfCashCodeToTxnType(''), null);
});
