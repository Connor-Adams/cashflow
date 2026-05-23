/**
 * Unit tests for the Wealthsimple TX code → TxnType mapping. The mapping is
 * the single source of truth used by both the import pipeline
 * (parseStatementFile.ts → NormalizedCashTransaction.overrideTxnType) and
 * the backfill script (scripts/backfill-ws-txn-types.ts).
 *
 * Pre-PR-#59 every negative-amount WS row stamped txnType='purchase' via the
 * narrative-only detector, which bloated the dashboard totalSpend metric.
 * These tests guard against regression on the explicit-code path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wsTxCodeToTxnType,
  inferWsTxnTypeFromNarrative,
} from '../src/import/wealthsimpleTxnType';

// === wsTxCodeToTxnType: code-driven mapping ===

test('BUY → investment', () => {
  assert.equal(wsTxCodeToTxnType('BUY'), 'investment');
});

test('SELL → investment', () => {
  assert.equal(wsTxCodeToTxnType('SELL'), 'investment');
});

test('DIV → dividend', () => {
  assert.equal(wsTxCodeToTxnType('DIV'), 'dividend');
});

test('CONT → transfer', () => {
  assert.equal(wsTxCodeToTxnType('CONT'), 'transfer');
});

test('AFT_IN → transfer (direct deposit)', () => {
  assert.equal(wsTxCodeToTxnType('AFT_IN'), 'transfer');
});

test('AFT_OUT → transfer (pre-authorized debit)', () => {
  assert.equal(wsTxCodeToTxnType('AFT_OUT'), 'transfer');
});

test('P2P_RECEIVED → transfer', () => {
  assert.equal(wsTxCodeToTxnType('P2P_RECEIVED'), 'transfer');
});

test('P2P_SENT → transfer', () => {
  assert.equal(wsTxCodeToTxnType('P2P_SENT'), 'transfer');
});

test('E_TRFIN → transfer', () => {
  assert.equal(wsTxCodeToTxnType('E_TRFIN'), 'transfer');
});

test('E_TRFOUT → transfer', () => {
  assert.equal(wsTxCodeToTxnType('E_TRFOUT'), 'transfer');
});

test('INT → interest', () => {
  assert.equal(wsTxCodeToTxnType('INT'), 'interest');
});

test('FPLINT → interest (stock lending)', () => {
  assert.equal(wsTxCodeToTxnType('FPLINT'), 'interest');
});

test('FEE → fee', () => {
  assert.equal(wsTxCodeToTxnType('FEE'), 'fee');
});

test('unknown TX code → null (defer to enrichment)', () => {
  assert.equal(wsTxCodeToTxnType('CRYPTORWD'), null);
  assert.equal(wsTxCodeToTxnType('REFUND'), null);
  assert.equal(wsTxCodeToTxnType('LOAN'), null);
});

test('empty / nullish → null', () => {
  assert.equal(wsTxCodeToTxnType(null), null);
  assert.equal(wsTxCodeToTxnType(undefined), null);
  assert.equal(wsTxCodeToTxnType(''), null);
});

test('case-insensitive and trims whitespace', () => {
  assert.equal(wsTxCodeToTxnType(' buy '), 'investment');
  assert.equal(wsTxCodeToTxnType('aft_out'), 'transfer');
});

// === inferWsTxnTypeFromNarrative: backfill-mode fallback ===

test('narrative: "Bought 0.0666 shares (executed at 2025-04-04)" → investment', () => {
  assert.equal(
    inferWsTxnTypeFromNarrative(
      'XEQT - iShares Core Equity ETF Portfolio: Bought 0.0666 shares (executed at 2025-04-04)',
    ),
    'investment',
  );
});

test('narrative: "Sold 187.4063 shares at $40.02..." → investment', () => {
  assert.equal(
    inferWsTxnTypeFromNarrative(
      'XEQT - iShares Core Equity ETF Portfolio: Sold 187.4063 shares at $40.02 per share (executed at 2025-12-31)',
    ),
    'investment',
  );
});

test('narrative: "Cash dividend distribution, received on..." → dividend', () => {
  assert.equal(
    inferWsTxnTypeFromNarrative(
      'XEQT - iShares Core Equity ETF Portfolio: Cash dividend distribution, received on 2026-01-05',
    ),
    'dividend',
  );
});

test('narrative: "Pre-authorized Debit to AMEX BILL PYMT" → transfer', () => {
  assert.equal(
    inferWsTxnTypeFromNarrative('Pre-authorized Debit to AMEX BILL PYMT'),
    'transfer',
  );
});

test('narrative: "Cash sent" → transfer', () => {
  assert.equal(inferWsTxnTypeFromNarrative('Cash sent'), 'transfer');
});

test('narrative: "Direct deposit from ADAMS GREENE HO" → transfer', () => {
  assert.equal(
    inferWsTxnTypeFromNarrative('Direct deposit from ADAMS GREENE HO'),
    'transfer',
  );
});

test('narrative: "Subscription fee paid for period..." → fee', () => {
  assert.equal(
    inferWsTxnTypeFromNarrative('Subscription fee paid for period 2025-01-01 to 2025-01-31'),
    'fee',
  );
});

test('narrative: "Stock lending monthly interest payment" → interest', () => {
  assert.equal(
    inferWsTxnTypeFromNarrative('Stock lending monthly interest payment'),
    'interest',
  );
});

test('narrative: unrelated description → null', () => {
  assert.equal(inferWsTxnTypeFromNarrative('STARBUCKS COFFEE 1234'), null);
});

test('narrative: empty / nullish → null', () => {
  assert.equal(inferWsTxnTypeFromNarrative(null), null);
  assert.equal(inferWsTxnTypeFromNarrative(undefined), null);
  assert.equal(inferWsTxnTypeFromNarrative(''), null);
});
