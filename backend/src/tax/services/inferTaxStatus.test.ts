import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferTaxStatus } from './inferTaxStatus';

test('inferTaxStatus maps registered account names', () => {
  assert.equal(inferTaxStatus('Wealthsimple TFSA'), 'registered_tfsa');
  assert.equal(inferTaxStatus('Individual FHSA'), 'registered_fhsa');
  assert.equal(inferTaxStatus('Individual RRSP'), 'registered_rrsp');
  assert.equal(inferTaxStatus('My RRIF'), 'registered_rrif');
  assert.equal(inferTaxStatus('RBC RDSP'), 'registered_rdsp');
  assert.equal(inferTaxStatus('Wealthsimple RESP'), 'registered_resp');
});

test('inferTaxStatus defaults unrecognised names to non_registered', () => {
  assert.equal(inferTaxStatus('Individual Margin'), 'non_registered');
  assert.equal(inferTaxStatus('Wealthsimple Investing'), 'non_registered');
  assert.equal(inferTaxStatus('Wealthsimple Crypto'), 'non_registered');
});
