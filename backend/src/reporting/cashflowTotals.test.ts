import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeReportingCashflow,
  type ReportingTxnRow,
} from './cashflowTotals';

const ESSENTIAL = new Set(['groceries', 'rent']);

test('negative purchase counts as spend', () => {
  const out = summarizeReportingCashflow([
    { amount: -50, txnType: 'purchase' },
  ]);
  assert.equal(out.totalSpend, 50);
  assert.equal(out.totalIncome, 0);
});

test('negative transfer / investment / payment are NOT spend (excluded from burn)', () => {
  const rows: ReportingTxnRow[] = [
    { amount: -5000, txnType: 'transfer' },
    { amount: -2500, txnType: 'investment' },
    { amount: -1200, txnType: 'payment' },
  ];
  const out = summarizeReportingCashflow(rows);
  assert.equal(out.totalSpend, 0);
});

test('positive income counts as income', () => {
  const out = summarizeReportingCashflow([
    { amount: 3200, txnType: 'income' },
  ]);
  assert.equal(out.totalIncome, 3200);
  assert.equal(out.totalSpend, 0);
});

test('positive refund / reward / unknown deposit are NOT income (the reporting bug)', () => {
  // Pre-fix these positives (txnType not payment/transfer) all bled into income.
  const rows: ReportingTxnRow[] = [
    { amount: 42, txnType: 'refund' },
    { amount: 25, txnType: 'reward' },
    { amount: 9351.93, txnType: 'unknown' }, // ATM deposit etc.
  ];
  const out = summarizeReportingCashflow(rows);
  assert.equal(out.totalIncome, 0);
  assert.equal(out.totalSpend, 0);
});

test('essentialSpend tracks essential-category negative amounts only', () => {
  const rows: ReportingTxnRow[] = [
    { amount: -300, txnType: 'purchase', finalCategory: 'Groceries' },
    { amount: -1500, txnType: 'purchase', finalCategory: 'Rent' },
    { amount: -80, txnType: 'purchase', finalCategory: 'Entertainment' },
  ];
  const out = summarizeReportingCashflow(rows, ESSENTIAL);
  assert.equal(out.totalSpend, 1880);
  assert.equal(out.essentialSpend, 1800);
});

test('unparseable amounts are skipped', () => {
  const out = summarizeReportingCashflow([
    { amount: 'not-a-number', txnType: 'purchase' },
    { amount: null, txnType: 'income' },
  ]);
  assert.equal(out.totalSpend, 0);
  assert.equal(out.totalIncome, 0);
});

test('mixed realistic set reconciles', () => {
  const rows: ReportingTxnRow[] = [
    { amount: 10726.4, txnType: 'income' }, // payroll
    { amount: 2000, txnType: 'income' }, // EI CANADA (now typed income)
    { amount: -300, txnType: 'purchase', finalCategory: 'Groceries' },
    { amount: -7000, txnType: 'transfer' }, // to WS — excluded
    { amount: 9351.93, txnType: 'unknown' }, // ATM deposit — excluded
    { amount: 45.18, txnType: 'refund' }, // excluded from income
  ];
  const out = summarizeReportingCashflow(rows, ESSENTIAL);
  assert.equal(out.totalIncome, 12726.4);
  assert.equal(out.totalSpend, 300);
  assert.equal(out.essentialSpend, 300);
});
