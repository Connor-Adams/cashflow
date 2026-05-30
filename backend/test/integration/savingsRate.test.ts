import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  savingsRate,
  type SavingsRateTxnRow,
} from '../../src/summary/savingsRate';

function txnRow(overrides: Partial<SavingsRateTxnRow>): SavingsRateTxnRow {
  return {
    id: Math.random(),
    date: '2026-05-15',
    currency: 'CAD',
    amount: '-100',
    accountId: 1,
    accountType: 'checking',
    txnType: 'purchase',
    finalCategory: 'Dining',
    finalBusiness: false,
    linkedTransactionId: null,
    ...overrides,
  };
}

test('savingsRate: income positive amounts', () => {
  const rows = [
    txnRow({ id: 1, amount: '5000', txnType: 'income', accountType: 'checking' }),
    txnRow({ id: 2, amount: '-2000', accountType: 'checking', finalCategory: 'Groceries' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.ok(trend);
  assert.equal(trend.series[0].income, 5000);
  assert.equal(trend.series[0].spending, 2000);
});

test('savingsRate: savings transfers to savings account', () => {
  const rows = [
    txnRow({ amount: '6000', txnType: 'income', accountType: 'checking' }),
    txnRow({ amount: '-1000', accountType: 'savings', txnType: 'transfer' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.ok(trend);
  assert.equal(trend.series[0].income, 6000);
  assert.equal(trend.series[0].savings, 1000);
});

test('savingsRate: investment classification', () => {
  const rows = [
    txnRow({ amount: '6000', txnType: 'income', accountType: 'checking' }),
    txnRow({ amount: '-500', accountType: 'investment', txnType: 'transfer' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.ok(trend);
  assert.equal(trend.series[0].investments, 500);
});

test('savingsRate: debt principal classification', () => {
  const rows = [
    txnRow({ id: 1, amount: '6000', txnType: 'income', accountType: 'checking' }),
    txnRow({ id: 2, amount: '-300', accountType: 'credit_card', txnType: 'transfer' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.ok(trend);
  assert.equal(trend.series[0].debtPrincipal, 300);
});

test('savingsRate: configurable inclusion of investments and debt', () => {
  const rows = [
    txnRow({ id: 1, amount: '1000', txnType: 'income', accountType: 'checking' }),
    txnRow({ id: 2, amount: '-200', accountType: 'savings', txnType: 'transfer' }),
    txnRow({ id: 3, amount: '-150', accountType: 'investment', txnType: 'transfer' }),
    txnRow({ id: 4, amount: '-100', accountType: 'credit_card', txnType: 'transfer' }),
  ];

  // Include all
  const resultAll = savingsRate(rows, ['2026-05'], true, true);
  const trendAll = resultAll.currencyTrends['CAD'];
  const expectedRateAll = ((200 + 150 + 100) / 1000) * 100; // 45%
  assert.equal(trendAll.series[0].savingsRate, expectedRateAll);

  // Exclude investments
  const resultNoInv = savingsRate(rows, ['2026-05'], false, true);
  const trendNoInv = resultNoInv.currencyTrends['CAD'];
  const expectedRateNoInv = ((200 + 100) / 1000) * 100; // 30%
  assert.equal(trendNoInv.series[0].savingsRate, expectedRateNoInv);

  // Exclude debt
  const resultNoDebt = savingsRate(rows, ['2026-05'], true, false);
  const trendNoDebt = resultNoDebt.currencyTrends['CAD'];
  const expectedRateNoDebt = ((200 + 150) / 1000) * 100; // 35%
  assert.equal(trendNoDebt.series[0].savingsRate, expectedRateNoDebt);
});

test('savingsRate: multiple months filled with zeros', () => {
  const rows = [
    txnRow({ date: '2026-05-15', amount: '2000', txnType: 'income', accountType: 'checking' }),
    txnRow({ date: '2026-07-15', amount: '3000', txnType: 'income', accountType: 'checking' }),
  ];
  const result = savingsRate(rows, ['2026-05', '2026-06', '2026-07']);
  const trend = result.currencyTrends['CAD'];
  assert.equal(trend.series.length, 3);
  assert.equal(trend.series[0].income, 2000);
  assert.equal(trend.series[1].income, 0); // June is zero-filled
  assert.equal(trend.series[2].income, 3000);
});

test('savingsRate: multiple currencies kept separate', () => {
  const rows = [
    txnRow({ currency: 'CAD', amount: '1000', txnType: 'income', accountType: 'checking' }),
    txnRow({ currency: 'USD', amount: '800', txnType: 'income', accountType: 'checking' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  assert.ok(result.currencyTrends['CAD']);
  assert.ok(result.currencyTrends['USD']);
  assert.equal(result.currencyTrends['CAD'].series[0].income, 1000);
  assert.equal(result.currencyTrends['USD'].series[0].income, 800);
});

test('savingsRate: zero income month returns null savingsRate', () => {
  const rows = [txnRow({ amount: '-100', accountType: 'checking' })]; // No income
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.equal(trend.series[0].savingsRate, null);
});
