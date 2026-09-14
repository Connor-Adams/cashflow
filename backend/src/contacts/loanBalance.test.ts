import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLoanBalance } from './loanBalance';

test('a lending contact nets outflows against inflows', () => {
  const rows = [
    { amount: -200, currency: 'CAD', counterpartyRole: null },
    { amount: 50, currency: 'CAD', counterpartyRole: null },
  ];
  assert.deepEqual(computeLoanBalance(rows, true), [
    { currency: 'CAD', lent: '200.0000', repaid: '50.0000', balance: '150.0000' },
  ]);
});

test('a non-lending contact has no balance at all', () => {
  const rows = [
    { amount: -4000, currency: 'CAD', counterpartyRole: null },
    { amount: 4000, currency: 'CAD', counterpartyRole: null },
  ];
  assert.deepEqual(computeLoanBalance(rows, false), []);
});

test('repayment beyond principal carries the balance through zero', () => {
  const rows = [
    { amount: -3648, currency: 'CAD', counterpartyRole: 'loan' },
    { amount: 3904.17, currency: 'CAD', counterpartyRole: 'repayment' },
  ];
  assert.deepEqual(computeLoanBalance(rows, false), [
    { currency: 'CAD', lent: '3648.0000', repaid: '3904.1700', balance: '-256.1700' },
  ]);
});

test('non-debt roles are excluded even when the contact lends', () => {
  const rows = [
    { amount: -4550, currency: 'CAD', counterpartyRole: 'purchase' },
    { amount: -2081.31, currency: 'CAD', counterpartyRole: 'business' },
    { amount: -200, currency: 'CAD', counterpartyRole: null },
  ];
  assert.deepEqual(computeLoanBalance(rows, true), [
    { currency: 'CAD', lent: '200.0000', repaid: '0.0000', balance: '200.0000' },
  ]);
});

test('currencies are isolated and sorted, never summed', () => {
  const rows = [
    { amount: -100, currency: 'USD', counterpartyRole: null },
    { amount: -200, currency: 'CAD', counterpartyRole: null },
  ];
  assert.deepEqual(computeLoanBalance(rows, true), [
    { currency: 'CAD', lent: '200.0000', repaid: '0.0000', balance: '200.0000' },
    { currency: 'USD', lent: '100.0000', repaid: '0.0000', balance: '100.0000' },
  ]);
});

test('repeated fractional cents do not drift', () => {
  const rows = Array.from({ length: 3 }, () => ({
    amount: -0.1, currency: 'CAD', counterpartyRole: 'loan' as string | null,
  }));
  assert.deepEqual(computeLoanBalance(rows, false), [
    { currency: 'CAD', lent: '0.3000', repaid: '0.0000', balance: '0.3000' },
  ]);
});

test('string amounts are accepted', () => {
  const rows = [{ amount: '-40.0000', currency: 'CAD', counterpartyRole: 'loan' }];
  assert.deepEqual(computeLoanBalance(rows, false), [
    { currency: 'CAD', lent: '40.0000', repaid: '0.0000', balance: '40.0000' },
  ]);
});
