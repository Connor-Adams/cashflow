import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferProfileId } from './inferProfile';

test('inferProfileId picks generic_simple for ISO bank CSV', () => {
  const headers = ['Date', 'Description', 'Amount'];
  const rows = [
    { Date: '2025-01-15', Description: 'Coffee', Amount: '-4.50' },
    { Date: '2025-01-16', Description: 'Shop', Amount: '-12.00' },
  ];
  assert.equal(inferProfileId(headers, rows, 'CAD'), 'generic_simple');
});

test('inferProfileId picks generic_amex when Charge Amount maps', () => {
  const headers = [
    'Transaction Date',
    'Appears On Your Statement As',
    'Charge Amount',
  ];
  const rows = [
    {
      'Transaction Date': '01/15/2025',
      'Appears On Your Statement As': 'CAFE',
      'Charge Amount': '25.00',
    },
  ];
  assert.equal(inferProfileId(headers, rows, 'CAD'), 'generic_amex');
});

test('inferProfileId falls back to headers when rows empty', () => {
  const headers = ['Posted Date', 'Charge Amount', 'Extended Details'];
  assert.equal(inferProfileId(headers, [], 'CAD'), 'generic_amex');
});

test('inferProfileId picks wealthsimple_cash for WS monthly headers', () => {
  const headers = ['date', 'transaction', 'description', 'amount', 'balance', 'currency'];
  const rows = [
    { date: '2025-04-30', transaction: 'INT', description: 'Interest received', amount: '0.13', balance: '102.45', currency: 'CAD' },
  ];
  assert.equal(inferProfileId(headers, rows, 'CAD'), 'wealthsimple_cash');
});

test('inferProfileId picks generic_simple for Visa snake_case CSV', () => {
  const headers = [
    'transaction_date',
    'post_date',
    'type',
    'details',
    'amount',
    'currency',
  ];
  const rows = [
    {
      transaction_date: '2025-11-18',
      post_date: '2025-11-18',
      type: 'Purchase',
      details: 'TU *TRANSUNION',
      amount: '28.19',
      currency: 'CAD',
    },
  ];
  assert.equal(inferProfileId(headers, rows, 'CAD'), 'generic_simple');
});

const RBC_HEADERS = [
  'Account Type', 'Account Number', 'Transaction Date', 'Cheque Number',
  'Description 1', 'Description 2', 'CAD$', 'USD$',
];
function rbcRow(accountType: string, cad: string) {
  return {
    'Account Type': accountType, 'Account Number': '6985',
    'Transaction Date': '5/15/2026', 'Cheque Number': '',
    'Description 1': 'ATM WITHDRAWAL', 'Description 2': '', 'CAD$': cad, 'USD$': '',
  };
}

test('inferProfileId picks rbc_banking for an RBC chequing export', () => {
  assert.equal(inferProfileId(RBC_HEADERS, [rbcRow('Chequing', '-90.00')], 'CAD'), 'rbc_banking');
});

test('inferProfileId keeps rbc for an RBC credit-card export', () => {
  assert.equal(inferProfileId(RBC_HEADERS, [rbcRow('Visa', '90.00')], 'CAD'), 'rbc');
});

test('inferProfileId defaults to rbc for RBC headers without an Account Type column', () => {
  const headers = ['Transaction Date', 'Description 1', 'Description 2', 'CAD$'];
  const rows = [{ 'Transaction Date': '5/15/2026', 'Description 1': 'X', 'Description 2': '', 'CAD$': '-1.00' }];
  assert.equal(inferProfileId(headers, rows, 'CAD'), 'rbc');
});
