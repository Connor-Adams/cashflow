import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferProfileId } from '../src/import/inferProfile';

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
