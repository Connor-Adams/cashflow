import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWsInvestmentBrandStage } from '../src/import/enrichment/wsInvestmentBrandStage';

function canonicalOf(raw: string): string | null {
  const signals = runWsInvestmentBrandStage({ merchantRaw: raw });
  if (signals.length === 0) return null;
  const c = signals[0].fields.merchantCanonical;
  return c ?? null;
}

test('ws-investment: ticker buy', () => {
  assert.equal(
    canonicalOf('XEQT - iShares Core Equity ETF Portfolio: Bought 0.3921 shares at $40.78 per share (executed at 2026-01-06)'),
    'XEQT — Buy',
  );
  assert.equal(
    canonicalOf('VFV - Vanguard S&P 500 Index ETF: Bought 14.7110 shares (executed at 2025-11-06)'),
    'VFV — Buy',
  );
});

test('ws-investment: ticker sell', () => {
  assert.equal(
    canonicalOf('NFLD - Exploits Discovery Corp: Sold 1500.0000 shares (executed at 2025-08-19)'),
    'NFLD — Sell',
  );
});

test('ws-investment: dividend', () => {
  assert.equal(
    canonicalOf('VFV - Vanguard S&P 500 Index ETF: Cash dividend distribution, received on 2025-10-07, record date of'),
    'VFV — Dividend',
  );
  assert.equal(
    canonicalOf('DOO - BRP Inc: Cash dividend distribution, received on 2025-10-14, record date of'),
    'DOO — Dividend',
  );
});

test('ws-investment: shares on loan / loan terminated', () => {
  assert.equal(
    canonicalOf('XEQT - iShares Core Equity ETF Portfolio: 2.0000 Shares on loan (executed at 2025-09-03)'),
    'XEQT — Loan out',
  );
  assert.equal(
    canonicalOf('PLUR - Plurilock Security Inc.: Loan of 3.0000 shares terminated (executed at 2025-03-03)'),
    'PLUR — Loan terminated',
  );
});

test('ws-investment: ticker transfer in', () => {
  assert.equal(
    canonicalOf('ETH - Ethereum: Transfer of 0.0036 ETH into the account (executed at 2024-10-01), FX Rate: 1.3488'),
    'ETH — Transfer in',
  );
});

test('ws-investment: crypto rewards', () => {
  assert.equal(canonicalOf('0.0020786267 of DOT rewards earned'), 'DOT — Stake reward');
  assert.equal(canonicalOf('0.0000714937 of ETH rewards earned'), 'ETH — Stake reward');
});

test('ws-investment: staked', () => {
  assert.equal(canonicalOf('Staked 0.0208474700 of ETH-Ethereum'), 'ETH — Stake');
  assert.equal(canonicalOf('Staked 4.9018380000 of DOT-Polkadot'), 'DOT — Stake');
});

test('ws-investment: crypto purchase/sale/fee', () => {
  assert.equal(
    canonicalOf('Purchase of 500000.0000000000 PEPE (executed at 2025-01-07), FX Rate: 1.4401, Fee charged $0.27'),
    'PEPE — Buy',
  );
  assert.equal(
    canonicalOf('Sale of 4.0000000000 XRP (executed at 2026-01-28), FX Rate: 1.3552'),
    'XRP — Sell',
  );
  assert.equal(
    canonicalOf('Trading fee for sale of 4.0000000000 XRP (executed at 2026-01-28), FX Rate: 1.3552'),
    'XRP — Trading fee',
  );
  assert.equal(
    canonicalOf('Fee paid on DOT-Polkadot staking reward:'),
    'DOT — Stake fee',
  );
});

test('ws-investment: cash account flow lines', () => {
  assert.equal(
    canonicalOf('Money transfer into the account (executed at 2024-12-13)'),
    'Money transfer in',
  );
  assert.equal(
    canonicalOf('Money transfer out of the account (executed at 2025-08-05)'),
    'Money transfer out',
  );
  assert.equal(
    canonicalOf('Tax-free money transfer into the account (executed at 2025-08-18)'),
    'Money transfer in',
  );
  assert.equal(
    canonicalOf('Tax-free money transfer out of the account (executed at 2025-08-18)'),
    'Money transfer out',
  );
  assert.equal(
    canonicalOf('Contribution (executed at 2025-11-02)'),
    'Contribution',
  );
  assert.equal(
    canonicalOf('Subscription fee paid for period 2025-10-07 to'),
    'WS Premium fee',
  );
  assert.equal(
    canonicalOf('Stock lending monthly interest payment'),
    'Stock lending interest',
  );
  assert.equal(
    canonicalOf('Interest received (executed at 2025-09-01)'),
    'Interest received',
  );
});

test('ws-investment: returns no signal for ordinary merchant strings', () => {
  assert.equal(runWsInvestmentBrandStage({ merchantRaw: 'STARBUCKS' }).length, 0);
  assert.equal(runWsInvestmentBrandStage({ merchantRaw: 'AMZN MKTP CA*B57UC85N2' }).length, 0);
  assert.equal(runWsInvestmentBrandStage({ merchantRaw: 'DOORDASHTHESAFFRONI' }).length, 0);
  assert.equal(runWsInvestmentBrandStage({ merchantRaw: '' }).length, 0);
});

test('ws-investment: signal source and confidence', () => {
  const signals = runWsInvestmentBrandStage({
    merchantRaw: 'Contribution (executed at 2025-11-02)',
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'ws-investment');
  assert.equal(signals[0].confidence, 'high');
});
