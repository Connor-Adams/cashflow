import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCsvRow } from '../src/import/mapRow';

test('mapCsvRow maps generic_simple', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'Test   Merchant ',
    Amount: '-10.00',
    Currency: 'usd',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_simple', 'USD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.date, '2025-02-01');
  assert.equal(r.value.merchantClean, 'Test Merchant');
  assert.equal(r.value.amount, -10);
  assert.equal(r.value.currency, 'USD');
});

test('mapCsvRow keeps payment rows positive for generic_simple', () => {
  const row = {
    Date: '2025-02-02',
    Description: 'ONLINE PAYMENT THANK YOU',
    Amount: '1200.00',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_simple', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.amount, 1200);
});

test('mapCsvRow uses transaction type to correct payment sign', () => {
  const row = {
    Date: '2025-02-03',
    Description: 'Payment',
    Type: 'Credit',
    Amount: '-1200.00',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_simple', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.amount, 1200);
});

test('mapCsvRow maps Visa snake_case export columns', () => {
  const row = {
    transaction_date: '2025-11-22',
    post_date: '2025-11-23',
    type: 'Purchase',
    details: 'VALUE BUDS APPLEBY CRO',
    amount: '33.87',
    currency: 'CAD',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_simple', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.date, '2025-11-22');
  assert.equal(r.value.merchantRaw, 'VALUE BUDS APPLEBY CRO');
  assert.equal(r.value.amount, -33.87);
  assert.equal(r.value.currency, 'CAD');
});

test('mapCsvRow falls back to type when Visa details are blank', () => {
  const row = {
    transaction_date: '2025-12-12',
    post_date: '2025-12-12',
    type: 'Monthly fee',
    details: '',
    amount: '10.0',
    currency: 'CAD',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_simple', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.date, '2025-12-12');
  assert.equal(r.value.merchantRaw, 'Monthly fee');
  assert.equal(r.value.merchantClean, 'Monthly fee');
  assert.equal(r.value.amount, -10);
});

test('mapCsvRow keeps WS "Interest received" positive under wealthsimple_cash', () => {
  const row = {
    date: '2025-04-30',
    transaction: 'INT',
    description: 'Interest received',
    amount: '0.13',
    balance: '102.45',
    currency: 'CAD',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'wealthsimple_cash', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.amount, 0.13);
  assert.equal(r.value.merchantRaw, 'Interest received');
});

test('mapCsvRow keeps WS "Interest earned" positive under wealthsimple_cash', () => {
  const row = {
    date: '2025-04-30',
    transaction: 'INT',
    description: 'Interest earned',
    amount: '58.05',
    balance: '5800.00',
    currency: 'CAD',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'wealthsimple_cash', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.amount, 58.05);
});

test('mapCsvRow keeps WS purchase rows negative under wealthsimple_cash', () => {
  const row = {
    date: '2025-04-15',
    transaction: 'SPEND',
    description: 'STARBUCKS COFFEE',
    amount: '-4.75',
    balance: '500.00',
    currency: 'CAD',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'wealthsimple_cash', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.amount, -4.75);
});

test('mapCsvRow keeps WS cash dividend positive under wealthsimple_cash', () => {
  const row = {
    date: '2025-04-30',
    transaction: 'DIV',
    description: 'Cash dividend',
    amount: '12.40',
    balance: '512.40',
    currency: 'CAD',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'wealthsimple_cash', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.amount, 12.4);
});
