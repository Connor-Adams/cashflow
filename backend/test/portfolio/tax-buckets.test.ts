/**
 * Unit tests for the pure tax-classification helpers in tax-buckets.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUsDomiciled,
  isFixedIncome,
  rowFlags,
  harvestCandidate,
  TAX_STATUS_LABELS,
  TAX_LOSS_THRESHOLD_CAD,
} from '../../src/portfolio/tax-buckets';

// isUsDomiciled
test('isUsDomiciled: metadata.country=USA → true', () => {
  assert.equal(isUsDomiciled({ symbol: 'VTI', currency: 'USD', metadata: { country: 'USA' } }), true);
});
test('isUsDomiciled: metadata.country=United States → true', () => {
  assert.equal(isUsDomiciled({ symbol: 'VTI', currency: 'USD', metadata: { country: 'United States' } }), true);
});
test('isUsDomiciled: metadata.country=Canada → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'XEQT.TO', currency: 'CAD', metadata: { country: 'Canada' } }), false);
});
test('isUsDomiciled: no metadata, .TO suffix → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'XEQT.TO', currency: 'CAD', metadata: null }), false);
});
test('isUsDomiciled: no metadata, .NEO suffix → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'HQU.NEO', currency: 'CAD', metadata: null }), false);
});
test('isUsDomiciled: no metadata, .L suffix → false (UK)', () => {
  assert.equal(isUsDomiciled({ symbol: 'VWRL.L', currency: 'GBP', metadata: null }), false);
});
test('isUsDomiciled: no metadata, bare symbol + USD → true', () => {
  assert.equal(isUsDomiciled({ symbol: 'VTI', currency: 'USD', metadata: null }), true);
});
test('isUsDomiciled: no metadata, bare symbol + CAD → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'BNS', currency: 'CAD', metadata: null }), false);
});
test('isUsDomiciled: no metadata, unknown suffix → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'NSRGY.OTC', currency: 'USD', metadata: null }), false);
});
test('isUsDomiciled: BRK.A US dotted symbol with USD → false (has suffix)', () => {
  assert.equal(isUsDomiciled({ symbol: 'BRK.A', currency: 'USD', metadata: null }), false);
});

// isFixedIncome
test('isFixedIncome: BOND → true', () => assert.equal(isFixedIncome('BOND'), true));
test('isFixedIncome: bond fund (lowercase) → true', () => assert.equal(isFixedIncome('bond fund'), true));
test('isFixedIncome: GIC → true', () => assert.equal(isFixedIncome('GIC'), true));
test('isFixedIncome: Fixed Income → true', () => assert.equal(isFixedIncome('Fixed Income'), true));
test('isFixedIncome: Treasury → true', () => assert.equal(isFixedIncome('Treasury'), true));
test('isFixedIncome: Debenture → true', () => assert.equal(isFixedIncome('Debenture'), true));
test('isFixedIncome: ETF → false', () => assert.equal(isFixedIncome('ETF'), false));
test('isFixedIncome: EQUITY → false', () => assert.equal(isFixedIncome('EQUITY'), false));
test('isFixedIncome: null → false', () => assert.equal(isFixedIncome(null), false));

// rowFlags
test('rowFlags: US security in non-reg → us_withholding', () => {
  const f = rowFlags({
    security: { symbol: 'VTI', currency: 'USD', assetType: 'ETF', metadata: null },
    account: { taxStatus: 'non_registered' },
    hasDividends: false,
  });
  assert.deepEqual(f.sort(), ['us_withholding']);
});
test('rowFlags: bond in non-reg → fixed_income_in_non_reg', () => {
  const f = rowFlags({
    security: { symbol: 'XBB.TO', currency: 'CAD', assetType: 'BOND', metadata: null },
    account: { taxStatus: 'non_registered' },
    hasDividends: false,
  });
  assert.deepEqual(f.sort(), ['fixed_income_in_non_reg']);
});
test('rowFlags: US dividend payer in TFSA → us_payer_in_tfsa', () => {
  const f = rowFlags({
    security: { symbol: 'VOO', currency: 'USD', assetType: 'ETF', metadata: null },
    account: { taxStatus: 'registered_tfsa' },
    hasDividends: true,
  });
  assert.deepEqual(f.sort(), ['us_payer_in_tfsa']);
});
test('rowFlags: US dividend payer in TFSA but no dividends → no flag', () => {
  const f = rowFlags({
    security: { symbol: 'VOO', currency: 'USD', assetType: 'ETF', metadata: null },
    account: { taxStatus: 'registered_tfsa' },
    hasDividends: false,
  });
  assert.deepEqual(f.sort(), []);
});
test('rowFlags: Cdn equity in RRSP → no flags', () => {
  const f = rowFlags({
    security: { symbol: 'BNS', currency: 'CAD', assetType: 'EQUITY', metadata: null },
    account: { taxStatus: 'registered_rrsp' },
    hasDividends: true,
  });
  assert.deepEqual(f.sort(), []);
});

// harvestCandidate
test('harvestCandidate: loss > $500 → candidate', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: 1000, marketValueCad: 400,
  });
  assert.deepEqual(c, { unrealizedLossCad: 600 });
});
test('harvestCandidate: loss == $500 → not a candidate (strict >)', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: 1000, marketValueCad: 500,
  });
  assert.equal(c, null);
});
test('harvestCandidate: gain → null', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: 1000, marketValueCad: 1500,
  });
  assert.equal(c, null);
});
test('harvestCandidate: null costBasisCad → null', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: null, marketValueCad: 500,
  });
  assert.equal(c, null);
});
test('harvestCandidate: null marketValueCad → null', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: 1000, marketValueCad: null,
  });
  assert.equal(c, null);
});

// Exports sanity
test('TAX_STATUS_LABELS has all six statuses', () => {
  assert.equal(TAX_STATUS_LABELS.registered_tfsa, 'TFSA');
  assert.equal(TAX_STATUS_LABELS.registered_rrsp, 'RRSP');
  assert.equal(TAX_STATUS_LABELS.non_registered, 'Non-registered');
  assert.equal(TAX_STATUS_LABELS.n_a, 'Other');
});
test('TAX_LOSS_THRESHOLD_CAD is 500', () => {
  assert.equal(TAX_LOSS_THRESHOLD_CAD, 500);
});
