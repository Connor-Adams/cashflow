import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferCsvDateOrdering, mapCsvRow } from './mapRow';

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

test('mapCsvRow honors trailing CR suffix as credit under invert_sign', () => {
  const row = {
    Date: '03/15/2025',
    Description: 'SOME VENDOR',
    Amount: '25.00 CR',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'amex', 'CAD');
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  assert.equal(r.value.amount, 25);
});

test('mapCsvRow honors trailing DR suffix as debit under passthrough', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'SOME VENDOR',
    Amount: '25.00DR',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_passthrough', 'CAD');
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  assert.equal(r.value.amount, -25);
});

test('mapCsvRow rejects amounts with unrecognized trailing text', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'SOME VENDOR',
    Amount: '25.00 USD',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_simple', 'CAD');
  assert.ok('error' in r, 'partial-parsing garbage suffixes silently corrupts amounts');
  if (!('error' in r)) return;
  assert.match(r.error, /Invalid amount/);
});

test('mapCsvRow trusts pre-signed amounts under passthrough despite payment-like Type', () => {
  // 'Card payment' on a bank/chequing export is money LEAVING the account;
  // the credit-card-centric /\bpayment\b/ heuristic must not flip it positive.
  const row = {
    Date: '2025-02-01',
    Type: 'Card payment',
    Description: 'HYDRO BILL',
    Amount: '-12.50',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_passthrough', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.amount, -12.5);
});

test('mapCsvRow parses European decimal comma "12,34" as 12.34, not 1234', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'CAFE PARIS',
    Amount: '-12,34',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_passthrough', 'CAD');
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  assert.equal(r.value.amount, -12.34);
});

test('mapCsvRow parses European "1.234,56" as 1234.56', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'SOME VENDOR',
    Amount: '1.234,56',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_passthrough', 'CAD');
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  assert.equal(r.value.amount, 1234.56);
});

test('mapCsvRow keeps North American "1,234.56" as 1234.56', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'SOME VENDOR',
    Amount: '1,234.56',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_passthrough', 'CAD');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.value.amount, 1234.56);
});

test('mapCsvRow parses comma-decimal split Débit column under national_bank', () => {
  const row = {
    'Date de transaction': '2025-02-01',
    Description: 'DEPANNEUR MTL',
    'Débit': '12,34',
    'Crédit': '',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'national_bank', 'CAD');
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  assert.equal(r.value.amount, -12.34);
});

test('mapCsvRow parses dollar-prefixed "$1,234.56"', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'SOME VENDOR',
    Amount: '$1,234.56',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_passthrough', 'CAD');
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  assert.equal(r.value.amount, 1234.56);
});

test('mapCsvRow parses accounting-negative "($10.00)" as -10', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'SOME VENDOR',
    Amount: '($10.00)',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_passthrough', 'CAD');
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  assert.equal(r.value.amount, -10);
});

test('mapCsvRow parses "-$10.00" as -10', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'SOME VENDOR',
    Amount: '-$10.00',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_passthrough', 'CAD');
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  assert.equal(r.value.amount, -10);
});

test('mapCsvRow parses "CA$5.00" prefix', () => {
  const row = {
    Date: '2025-02-01',
    Description: 'SOME VENDOR',
    Amount: 'CA$5.00',
  };
  const headers = Object.keys(row);
  const r = mapCsvRow(row, headers, 'generic_passthrough', 'CAD');
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  assert.equal(r.value.amount, 5);
});

test('inferCsvDateOrdering detects day-first files from unambiguous rows', () => {
  const headers = ['Date', 'Description', 'Amount'];
  const records = [
    { Date: '15/03/2025', Description: 'A', Amount: '-1.00' },
    { Date: '03/04/2025', Description: 'B', Amount: '-2.00' },
  ];
  assert.equal(inferCsvDateOrdering(records, headers, 'generic_simple'), 'day-first');
});

test('mapCsvRow applies inferred day-first ordering to ambiguous rows', () => {
  const headers = ['Date', 'Description', 'Amount'];
  const records = [
    { Date: '15/03/2025', Description: 'A', Amount: '-1.00' },
    { Date: '03/04/2025', Description: 'B', Amount: '-2.00' },
  ];
  const ordering = inferCsvDateOrdering(records, headers, 'generic_simple');
  const r = mapCsvRow(records[1], headers, 'generic_simple', 'CAD', ordering);
  assert.ok(!('error' in r), `expected mapped row, got ${JSON.stringify(r)}`);
  if ('error' in r) return;
  // dd/MM file: 03/04 is April 3rd, not March 4th.
  assert.equal(r.value.date, '2025-04-03');
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
