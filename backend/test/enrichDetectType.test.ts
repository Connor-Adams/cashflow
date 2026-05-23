import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectTypeStage } from '../src/import/enrichment/detectTypeStage';

test('refund: narrative says refund + positive amount', () => {
  const signals = runDetectTypeStage({
    merchantRaw: 'AMAZON.COM REFUND',
    merchantClean: 'AMAZON.COM REFUND',
    amount: 42.0,
  });
  assert.equal(signals[0].fields.txnType, 'refund');
  assert.equal(signals[0].confidence, 'high');
});

test('transfer: narrative says transfer + opposite signs handled', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'TRANSFER TO CHEQUING',
    merchantClean: 'TRANSFER TO CHEQUING',
    amount: -500,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('payment: narrative says online payment + positive', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'ONLINE PAYMENT THANK YOU',
    merchantClean: 'ONLINE PAYMENT THANK YOU',
    amount: 1200,
  });
  assert.equal(out[0].fields.txnType, 'payment');
});

test('fee: narrative says annual fee', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'ANNUAL FEE',
    merchantClean: 'ANNUAL FEE',
    amount: -120,
  });
  assert.equal(out[0].fields.txnType, 'fee');
});

test('interest: interest charge narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'INTEREST CHARGE ON PURCHASES',
    merchantClean: 'INTEREST CHARGE ON PURCHASES',
    amount: -15.5,
  });
  assert.equal(out[0].fields.txnType, 'interest');
});

test('reward: cash back / reward narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'CASH BACK REWARD',
    merchantClean: 'CASH BACK REWARD',
    amount: 25,
  });
  assert.equal(out[0].fields.txnType, 'reward');
});

test('purchase: default when nothing else matches and negative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'STARBUCKS',
    merchantClean: 'STARBUCKS',
    amount: -6.5,
  });
  assert.equal(out[0].fields.txnType, 'purchase');
  assert.equal(out[0].confidence, 'medium');
});

test('unknown: positive amount with no narrative cue', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'JOE COFFEE',
    merchantClean: 'JOE COFFEE',
    amount: 100,
  });
  assert.equal(out[0].fields.txnType, 'unknown');
});

// === Wealthsimple narrative patterns ===
// These were added when the bundle importer started routing the same
// descriptions through the regular /upload path. Each test guards against
// regression to the pre-PR-#59 behavior where every negative-amount WS row
// defaulted to 'purchase' and bloated the dashboard totalSpend metric.

test('transfer: pre-authorized debit (AFT_OUT narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
    merchantClean: 'Pre-authorized Debit to AMEX BILL PYMT',
    amount: -2959.34,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: pre-authorized credit', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Pre-authorized Credit from EMPLOYER',
    merchantClean: 'Pre-authorized Credit from EMPLOYER',
    amount: 5000,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: cash sent (P2P_SENT narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Cash sent',
    merchantClean: 'Cash sent',
    amount: -2500,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: cash received (P2P_RECEIVED narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Cash received',
    merchantClean: 'Cash received',
    amount: 100,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: direct deposit (AFT_IN narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Direct deposit from ADAMS GREENE HO',
    merchantClean: 'Direct deposit from ADAMS GREENE HO',
    amount: 207.4,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('fee: subscription fee paid for period', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Subscription fee paid for period 2025-01-01 to 2025-01-31',
    merchantClean: 'Subscription fee paid for period 2025-01-01 to 2025-01-31',
    amount: -10,
  });
  assert.equal(out[0].fields.txnType, 'fee');
});

test('fee: staking reward fee', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Fee paid on DOT-Polkadot staking reward fee',
    merchantClean: 'Fee paid on DOT-Polkadot staking reward fee',
    amount: -0.05,
  });
  assert.equal(out[0].fields.txnType, 'fee');
});

test('investment: bought N shares (BUY narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Bought 0.0666 shares (executed at 2025-04-04)',
    merchantClean: 'XEQT - iShares Core Equity ETF Portfolio: Bought 0.0666 shares (executed at 2025-04-04)',
    amount: -2500,
  });
  assert.equal(out[0].fields.txnType, 'investment');
});

test('investment: sold N shares (SELL narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Sold 187.4063 shares at $40.02 per share (executed at 2025-12-31)',
    merchantClean: 'XEQT - iShares Core Equity ETF Portfolio: Sold 187.4063 shares at $40.02 per share (executed at 2025-12-31)',
    amount: 7500.51,
  });
  assert.equal(out[0].fields.txnType, 'investment');
});

test('dividend: cash dividend distribution (DIV narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Cash dividend distribution, received on 2026-01-05',
    merchantClean: 'XEQT - iShares Core Equity ETF Portfolio: Cash dividend distribution, received on 2026-01-05',
    amount: 146.47,
  });
  assert.equal(out[0].fields.txnType, 'dividend');
});

test('interest: stock lending monthly interest', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Stock lending monthly interest payment',
    merchantClean: 'Stock lending monthly interest payment',
    amount: 0.01,
  });
  assert.equal(out[0].fields.txnType, 'interest');
});
