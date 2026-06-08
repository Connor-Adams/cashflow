import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWsInvestRow,
  wsRecordsHaveSecurityActivity,
  type WsRow,
} from './wealthsimpleInvestParse';

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

test('FEE: crypto trading fee links to security, uses exec-at', () => {
  const r = parseWsInvestRow(
    row({
      date: '2026-01-28',
      transaction: 'FEE',
      description:
        'Trading fee for sale of 4.0000000000 XRP (executed at 2026-01-28), FX Rate: 1.3552',
      amount: '-0.09',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'fee');
  assert.equal(r.tradeDate, '2026-01-28');
  assert.equal(r.security?.symbol, 'XRP');
  assert.equal(r.security?.assetType, 'cryptocurrency');
  assert.equal(r.quantity, null);
  assert.equal(r.amount, -0.09);
});

test('FEE: crypto staking-reward fee links to security by SYMBOL-Name', () => {
  const r = parseWsInvestRow(
    row({
      date: '2024-11-01',
      transaction: 'FEE',
      description: 'Fee paid on DOT-Polkadot staking reward: 0.0007988466',
      amount: '0',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'fee');
  assert.equal(r.tradeDate, '2024-11-01');
  assert.equal(r.security?.symbol, 'DOT');
  assert.equal(r.security?.name, 'Polkadot');
  assert.equal(r.security?.assetType, 'cryptocurrency');
  assert.equal(r.quantity, null);
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

test('CRYPTORWD: extracts symbol + quantity, emits staking_reward activity', () => {
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
  assert.ok(r);
  assert.equal(r.activityType, 'staking_reward');
  assert.equal(r.tradeDate, '2025-01-01');
  assert.equal(r.security?.symbol, 'DOT');
  assert.equal(r.security?.assetType, 'cryptocurrency');
  assert.equal(r.quantity, 0.0020732867);
  assert.equal(r.amount, 0);
});

test('CRYPTORWD ETH variant', () => {
  const r = parseWsInvestRow(
    row({
      date: '2025-02-15',
      transaction: 'CRYPTORWD',
      description: '0.0000714937 of ETH rewards earned',
      amount: '0.0',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'staking_reward');
  assert.equal(r.security?.symbol, 'ETH');
  assert.equal(r.quantity, 0.0000714937);
});

test('CRYPTORWD with unparseable description: still returns staking_reward but null security', () => {
  const r = parseWsInvestRow(
    row({
      date: '2025-01-01',
      transaction: 'CRYPTORWD',
      description: 'unexpected description shape',
      amount: '0.0',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'staking_reward');
  assert.equal(r.security, null);
  assert.equal(r.quantity, null);
});

test('Crypto BUY: extracts symbol, qty, exec-at from "Purchase of N SYM" format', () => {
  const r = parseWsInvestRow(
    row({
      date: '2024-10-22',
      transaction: 'BUY',
      description:
        'Purchase of 0.0544286100 ETH (executed at 2024-10-23), FX Rate: 1.3877, Fee charged $3.94',
      amount: '-200.0',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'buy');
  assert.equal(r.tradeDate, '2024-10-23');
  assert.equal(r.security?.symbol, 'ETH');
  assert.equal(r.security?.assetType, 'cryptocurrency');
  assert.equal(r.quantity, 0.05442861);
  assert.equal(r.amount, -200);
});

test('Crypto SELL: extracts symbol, qty, exec-at from "Sale of N SYM" format', () => {
  const r = parseWsInvestRow(
    row({
      date: '2026-01-28',
      transaction: 'SELL',
      description: 'Sale of 4.0000000000 XRP (executed at 2026-01-28), FX Rate: 1.3552',
      amount: '10.36',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.activityType, 'sell');
  assert.equal(r.tradeDate, '2026-01-28');
  assert.equal(r.security?.symbol, 'XRP');
  assert.equal(r.security?.assetType, 'cryptocurrency');
  assert.equal(r.quantity, 4);
  assert.equal(r.amount, 10.36);
});

test('Crypto BUY: large-quantity tokens parse without scientific notation', () => {
  const r = parseWsInvestRow(
    row({
      date: '2024-12-13',
      transaction: 'BUY',
      description:
        'Purchase of 1000000.0000000000 PEPE (executed at 2024-12-13), FX Rate: 1.4292, Fee charged $0.70',
      amount: '-50.0',
    }),
    ACCOUNT_ID,
    DEFAULT_CCY,
  );
  assert.ok(r);
  assert.equal(r.security?.symbol, 'PEPE');
  assert.equal(r.quantity, 1_000_000);
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

// ─── wsRecordsHaveSecurityActivity ──────────────────────────────────────────
// Drives the import-time accountType self-heal: a WS monthly statement that
// carries SECURITY-bearing activity (BUY/SELL/DIV/CRYPTORWD) implies a
// brokerage account. Pure cash codes (CONT/INT/FPLINT/FEE/AFT_*/P2P_*) must
// NOT trigger it, so a HISA like "Save for Business" (CONT + Interest received)
// is never mis-upgraded to 'investment'.

function rec(transaction: string, key: 'transaction' | 'Transaction' = 'transaction') {
  return { [key]: transaction, description: 'x', amount: '1', currency: 'CAD' } as Record<
    string,
    string
  >;
}

test('security activity: BUY present → true', () => {
  assert.equal(wsRecordsHaveSecurityActivity([rec('CONT'), rec('BUY')]), true);
});

test('security activity: SELL present → true', () => {
  assert.equal(wsRecordsHaveSecurityActivity([rec('SELL')]), true);
});

test('security activity: DIV present → true', () => {
  assert.equal(wsRecordsHaveSecurityActivity([rec('DIV')]), true);
});

test('security activity: CRYPTORWD present → true', () => {
  assert.equal(wsRecordsHaveSecurityActivity([rec('CRYPTORWD')]), true);
});

test('security activity: case-insensitive code → true', () => {
  assert.equal(wsRecordsHaveSecurityActivity([rec('buy')]), true);
});

test('security activity: capitalized "Transaction" header key → true', () => {
  assert.equal(wsRecordsHaveSecurityActivity([rec('DIV', 'Transaction')]), true);
});

test('cash-only HISA codes (CONT + INT) → false (Save-for-Business class)', () => {
  assert.equal(
    wsRecordsHaveSecurityActivity([rec('CONT'), rec('INT'), rec('CONT')]),
    false,
  );
});

test('cash movement codes (AFT_OUT / P2P_SENT / FPLINT / FEE) → false', () => {
  assert.equal(
    wsRecordsHaveSecurityActivity([
      rec('AFT_OUT'),
      rec('P2P_SENT'),
      rec('FPLINT'),
      rec('FEE'),
    ]),
    false,
  );
});

test('security activity: empty record set → false', () => {
  assert.equal(wsRecordsHaveSecurityActivity([]), false);
});

test('security activity: missing transaction column → false', () => {
  assert.equal(
    wsRecordsHaveSecurityActivity([{ description: 'x', amount: '1' } as Record<string, string>]),
    false,
  );
});
