import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWsInvestRow, type WsRow } from '../src/import/wealthsimpleInvestParse';

const ACCOUNT_ID = 42;
const DEFAULT_CCY = 'CAD';

function row(partial: Partial<WsRow>): WsRow {
  return {
    date: '2025-01-15',
    transaction: '',
    description: '',
    amount: '0',
    balance: '0',
    currency: 'CAD',
    ...partial,
  };
}

test('BUY with full description: extracts ticker, name, qty, exec date', () => {
  const r = parseWsInvestRow(
    row({
      date: '2026-01-09',
      transaction: 'BUY',
      description:
        'VFV - Vanguard S&P 500 Index ETF: Bought 0.4076 shares at $170.43 per share (executed at 2026-01-08)',
      amount: '-69.47',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'buy');
  assert.equal(r.tradeDate, '2026-01-08');
  assert.ok(r.security);
  assert.equal(r.security!.symbol, 'VFV');
  assert.equal(r.security!.name, 'Vanguard S&P 500 Index ETF');
  assert.equal(r.security!.currency, 'CAD');
  assert.equal(r.quantity, 0.4076);
  assert.equal(r.amount, -69.47);
  assert.equal(r.currency, 'CAD');
  assert.ok(r.sourceRowFingerprint.length > 0);
});

test('SELL with full description', () => {
  const r = parseWsInvestRow(
    row({
      date: '2026-01-02',
      transaction: 'SELL',
      description:
        'XEQT - iShares Core Equity ETF Portfolio: Sold 187.4063 shares at $40.02 per share (executed at 2025-12-31)',
      amount: '7500.51',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'sell');
  assert.equal(r.tradeDate, '2025-12-31');
  assert.equal(r.security?.symbol, 'XEQT');
  assert.equal(r.quantity, 187.4063);
  assert.equal(r.amount, 7500.51);
});

test('DIV: dividend with no qty, uses received-on date', () => {
  const r = parseWsInvestRow(
    row({
      date: '2025-01-03',
      transaction: 'DIV',
      description:
        'XEQT - iShares Core Equity ETF Portfolio: Cash dividend distribution, received on 2025-01-03, record date of 2024-12-30',
      amount: '1.66',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'dividend');
  assert.equal(r.tradeDate, '2025-01-03');
  assert.equal(r.security?.symbol, 'XEQT');
  assert.equal(r.quantity, null);
  assert.equal(r.amount, 1.66);
});

test('FPLINT: stock-lending interest with no ticker, fallback path', () => {
  const r = parseWsInvestRow(
    row({
      date: '2026-01-15',
      transaction: 'FPLINT',
      description: 'Stock lending monthly interest payment',
      amount: '0.01',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'interest');
  assert.equal(r.tradeDate, '2026-01-15');
  assert.equal(r.security, null);
  assert.equal(r.quantity, null);
  assert.equal(r.amount, 0.01);
});

test('CONT: contribution maps to transfer, no security', () => {
  const r = parseWsInvestRow(
    row({
      date: '2026-01-08',
      transaction: 'CONT',
      description: 'Contribution (executed at 2026-01-08)',
      amount: '7000.0',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'transfer');
  assert.equal(r.security, null);
  assert.equal(r.amount, 7000);
  assert.equal(r.tradeDate, '2026-01-08');
});

test('INT: interest earned (no ticker)', () => {
  const r = parseWsInvestRow(
    row({
      date: '2025-01-01',
      transaction: 'INT',
      description: 'Interest earned',
      amount: '39.85',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'interest');
  assert.equal(r.security, null);
  assert.equal(r.amount, 39.85);
});

test('FEE: subscription fee paid (no ticker)', () => {
  const r = parseWsInvestRow(
    row({
      date: '2025-05-01',
      transaction: 'FEE',
      description: 'Subscription fee paid for Wealthsimple Premium',
      amount: '-10.0',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'fee');
  assert.equal(r.security, null);
  assert.equal(r.amount, -10);
});

test('P2P_RECEIVED returns null', () => {
  const r = parseWsInvestRow(
    row({
      date: '2025-01-10',
      transaction: 'P2P_RECEIVED',
      description: 'P2P received',
      amount: '10.0',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.equal(r, null);
});

test('CRYPTORWD returns null', () => {
  const r = parseWsInvestRow(
    row({
      date: '2025-01-01',
      transaction: 'CRYPTORWD',
      description: '0.0020732867 of DOT rewards earned',
      amount: '0.0',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.equal(r, null);
});

test('BUY with malformed description: falls back to row.date and null security', () => {
  const r = parseWsInvestRow(
    row({
      date: '2025-06-10',
      transaction: 'BUY',
      description: 'something malformed without ticker format',
      amount: '-100',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'buy');
  assert.equal(r.tradeDate, '2025-06-10');
  assert.equal(r.security, null);
  assert.equal(r.quantity, null);
  assert.equal(r.amount, -100);
});

test('currency falls back to default when row currency empty', () => {
  const r = parseWsInvestRow(
    row({
      date: '2025-01-01',
      transaction: 'INT',
      description: 'Interest earned',
      amount: '1.00',
      currency: '',
    }),
    ACCOUNT_ID,
    'usd',
  );
  assert.ok(r);
  assert.equal(r.currency, 'USD');
});
