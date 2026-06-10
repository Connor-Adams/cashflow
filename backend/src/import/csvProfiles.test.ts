import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listImportProfiles, profiles } from './csvProfiles';
import { mapCsvRow } from './mapRow';

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

test('rbc USD rows import from the USD$ column when CAD$ is blank', () => {
  // RBC exports always include both CAD$ and USD$; a USD transaction leaves
  // CAD$ empty. The row must not be dropped as "missing columns".
  const row = { ...rbcRow('Visa', '', 'US VENDOR'), 'USD$': '12.50' };
  const m = mapCsvRow(row, RBC_HEADERS, 'rbc', 'CAD');
  assert.ok(!('error' in m), `expected mapped row, got ${JSON.stringify(m)}`);
  if ('error' in m) return;
  assert.equal(m.value.amount, -12.5);
  assert.equal(m.value.currency, 'USD');
});

test('rbc_banking USD rows keep source sign and USD currency', () => {
  const row = { ...rbcRow('Chequing', '', 'US VENDOR'), 'USD$': '-40.00' };
  const m = mapCsvRow(row, RBC_HEADERS, 'rbc_banking', 'CAD');
  assert.ok(!('error' in m), `expected mapped row, got ${JSON.stringify(m)}`);
  if ('error' in m) return;
  assert.equal(m.value.amount, -40);
  assert.equal(m.value.currency, 'USD');
});

test('rbc CAD rows still default to CAD currency', () => {
  const m = mapCsvRow(rbcRow('Visa', '90.00'), RBC_HEADERS, 'rbc', 'CAD');
  assert.ok(!('error' in m));
  if ('error' in m) return;
  assert.equal(m.value.currency, 'CAD');
});

test('generic_simple hint describes its charges_negative convention, not a pre-signed file', () => {
  const entry = listImportProfiles().find((p) => p.id === 'generic_simple');
  assert.ok(entry);
  // The convention forces positive amounts negative, so the hint must not
  // claim 'negative = charge' (that describes the pre-signed profile).
  assert.match(entry!.hint, /positive = charge/i);
  assert.doesNotMatch(entry!.hint, /negative = charge/i);
});
