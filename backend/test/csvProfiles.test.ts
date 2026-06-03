import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listImportProfiles, profiles } from '../src/import/csvProfiles';
import { mapCsvRow } from '../src/import/mapRow';

const RBC_HEADERS = [
  'Account Type',
  'Account Number',
  'Transaction Date',
  'Cheque Number',
  'Description 1',
  'Description 2',
  'CAD$',
  'USD$',
];
function rbcRow(accountType: string, cad: string, desc = 'SOME VENDOR') {
  return {
    'Account Type': accountType,
    'Account Number': '6985',
    'Transaction Date': '5/15/2026',
    'Cheque Number': '',
    'Description 1': desc,
    'Description 2': '',
    'CAD$': cad,
    'USD$': '',
  };
}
function amountOf(m: ReturnType<typeof mapCsvRow>): number {
  assert.ok(!('error' in m), `expected mapped row, got ${JSON.stringify(m)}`);
  return m.value.amount;
}

test('listImportProfiles returns distinct profile definitions', () => {
  const list = listImportProfiles();
  assert.ok(list.length >= 2);
  const ids = list.map((x) => x.id);
  assert.ok(ids.includes('generic_simple'));
  assert.ok(ids.includes('generic_amex'));
  assert.ok(ids.includes('wealthsimple_cash'));
  assert.ok(
    !ids.includes('amex'),
    'duplicate amex ref should be omitted in favor of generic_amex'
  );
});

test('wealthsimple_cash profile uses passthrough sign convention', () => {
  const p = profiles.wealthsimple_cash;
  assert.ok(p, 'wealthsimple_cash profile missing');
  assert.equal(p.amountConvention, 'passthrough');
});

test('listImportProfiles entries reference existing profile ids', () => {
  for (const row of listImportProfiles()) {
    assert.ok(profiles[row.id], `missing profile ${row.id}`);
  }
});

test('rbc_banking profile uses passthrough sign convention', () => {
  assert.equal(profiles.rbc_banking?.amountConvention, 'passthrough');
});

test('rbc_banking preserves source sign (withdrawal stays negative, deposit positive)', () => {
  // RBC banking CSV CAD$ is already signed: withdrawal negative, deposit positive.
  assert.equal(amountOf(mapCsvRow(rbcRow('Chequing', '-90.00'), RBC_HEADERS, 'rbc_banking', 'CAD')), -90);
  assert.equal(amountOf(mapCsvRow(rbcRow('Chequing', '1500.00'), RBC_HEADERS, 'rbc_banking', 'CAD')), 1500);
});

test('rbc credit-card profile still inverts (positive source charge -> negative)', () => {
  assert.equal(amountOf(mapCsvRow(rbcRow('Visa', '90.00'), RBC_HEADERS, 'rbc', 'CAD')), -90);
});

test('listImportProfiles includes rbc_banking', () => {
  assert.ok(listImportProfiles().some((p) => p.id === 'rbc_banking'));
});
