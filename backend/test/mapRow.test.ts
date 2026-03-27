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
