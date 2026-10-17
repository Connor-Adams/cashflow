import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATES_2026 } from './rates-2026';
import { RATES_2027, INDEXATION_FACTOR_2027 } from './rates-2027';
import { ratesFor, supportedYears } from '../engine/brackets';
import { D } from '../util/decimal';

// RATES_2027 is a PROJECTION: CRA publishes the real 2027 indexation factor in
// ~Nov 2026. Until then 2027 is 2026 indexed by INDEXATION_FACTOR_2027, with
// statutorily fixed amounts left alone. These tests lock that contract so a
// later hand-edit that forgets the "fixed" list is caught.

// Bases are read from RATES_2026 rather than hardcoded. An earlier version wrote
// the 2026 numbers as literals here, so correcting 2026 left this file asserting
// against values that no longer existed anywhere.
/** 2026 value × factor, rounded half-up to the nearest dollar (CRA convention). */
function indexed(base: string): string {
  return D(base).times(D(String(INDEXATION_FACTOR_2027))).toDecimalPlaces(0, 4).toString();
}

test('2027 is a supported rate year', () => {
  assert.deepEqual(ratesFor(2027), RATES_2027);
  assert.ok(supportedYears().includes(2027));
});

test('2027 federal bracket thresholds are 2026 indexed by the declared factor', () => {
  const expected = RATES_2026.federalBrackets.map((b) =>
    b.upTo === null ? null : indexed(b.upTo.toString()),
  );
  const actual = RATES_2027.federalBrackets.map((b) =>
    b.upTo === null ? null : b.upTo.toString(),
  );
  assert.deepEqual(actual, expected);
});

test('2027 federal bracket rates are unchanged from 2026 (no legislated change known)', () => {
  assert.deepEqual(
    RATES_2027.federalBrackets.map((b) => b.rate.toString()),
    RATES_2026.federalBrackets.map((b) => b.rate.toString()),
  );
});

test('2027 Ontario top two bracket thresholds stay unindexed at 150k/220k', () => {
  assert.equal(RATES_2027.provincialBrackets[2].upTo?.toString(), '150000');
  assert.equal(RATES_2027.provincialBrackets[3].upTo?.toString(), '220000');
});

test('2027 Ontario lower bracket thresholds are 2026 indexed', () => {
  assert.equal(RATES_2027.provincialBrackets[0].upTo?.toString(), indexed(RATES_2026.provincialBrackets[0].upTo!.toString()));
  assert.equal(RATES_2027.provincialBrackets[1].upTo?.toString(), indexed(RATES_2026.provincialBrackets[1].upTo!.toString()));
});

test('2027 federal BPA is 2026 indexed and its phaseout tracks the top two brackets', () => {
  assert.equal(RATES_2027.basicPersonalAmountFederal.toString(), indexed(RATES_2026.basicPersonalAmountFederal.toString()));
  assert.equal(
    RATES_2027.bpaFederalPhaseoutStart.toString(),
    RATES_2027.federalBrackets[2].upTo?.toString(),
  );
  assert.equal(
    RATES_2027.bpaFederalPhaseoutEnd.toString(),
    RATES_2027.federalBrackets[3].upTo?.toString(),
  );
});

test('2027 AMT exemption tracks the bottom of the 4th federal bracket', () => {
  assert.equal(
    RATES_2027.amtExemption.toString(),
    RATES_2027.federalBrackets[2].upTo?.toString(),
  );
});

test('2027 leaves statutorily fixed amounts unindexed', () => {
  const fixed: Array<[string, string]> = [
    ['cpp.basicExemption', RATES_2027.cpp.basicExemption.toString()],
    ['pensionIncomeAmountCap', RATES_2027.pensionIncomeAmountCap.toString()],
    ['fhsaAnnualLimit', RATES_2027.fhsaAnnualLimit.toString()],
    ['fhsaLifetimeLimit', RATES_2027.fhsaLifetimeLimit.toString()],
    ['donationHighRateThreshold', RATES_2027.donationHighRateThreshold.toString()],
    ['capitalGainsInclusionThreshold', RATES_2027.capitalGainsInclusionThreshold!.toString()],
    ['corpSbdAnnualLimit', RATES_2027.corpSbdAnnualLimit.toString()],
    ['corpAaiiGrindThreshold', RATES_2027.corpAaiiGrindThreshold.toString()],
  ];
  const expected: Array<[string, string]> = [
    ['cpp.basicExemption', RATES_2026.cpp.basicExemption.toString()],
    ['pensionIncomeAmountCap', RATES_2026.pensionIncomeAmountCap.toString()],
    ['fhsaAnnualLimit', RATES_2026.fhsaAnnualLimit.toString()],
    ['fhsaLifetimeLimit', RATES_2026.fhsaLifetimeLimit.toString()],
    ['donationHighRateThreshold', RATES_2026.donationHighRateThreshold.toString()],
    ['capitalGainsInclusionThreshold', RATES_2026.capitalGainsInclusionThreshold!.toString()],
    ['corpSbdAnnualLimit', RATES_2026.corpSbdAnnualLimit.toString()],
    ['corpAaiiGrindThreshold', RATES_2026.corpAaiiGrindThreshold.toString()],
  ];
  assert.deepEqual(fixed, expected);
});

test('2027 corp T2 rates are unchanged from 2026 (no announced change)', () => {
  assert.equal(RATES_2027.corpAbiSbdRateFederal.toString(), RATES_2026.corpAbiSbdRateFederal.toString());
  assert.equal(RATES_2027.corpGeneralRateOntario.toString(), RATES_2026.corpGeneralRateOntario.toString());
  assert.equal(RATES_2027.corpInvestmentRateFederal.toString(), RATES_2026.corpInvestmentRateFederal.toString());
  assert.equal(RATES_2027.corpDividendRefundRate.toString(), RATES_2026.corpDividendRefundRate.toString());
});

// Every scalar the projection indexes, read off both tables by the same picker.
// A field left on an older 2026 placeholder (rather than the published 2026
// value) fails here — which is how the ON age amount, disability, caregiver and
// ON pension amounts drifted before.
const INDEXED_SCALARS: Array<[string, (r: typeof RATES_2026) => { toString(): string }]> = [
  ['basicPersonalAmountFederal', (r) => r.basicPersonalAmountFederal],
  ['bpaFederalMin', (r) => r.bpaFederalMin],
  ['basicPersonalAmountOntario', (r) => r.basicPersonalAmountOntario],
  ['spousalAmountOntario', (r) => r.spousalAmountOntario],
  ['ageAmountFederal', (r) => r.ageAmountFederal],
  ['ageAmountOntario', (r) => r.ageAmountOntario],
  ['ageAmountFederalThreshold', (r) => r.ageAmountFederalThreshold],
  ['ageAmountOntarioThreshold', (r) => r.ageAmountOntarioThreshold],
  ['employmentAmountFederal', (r) => r.employmentAmountFederal],
  ['cpp.ympe', (r) => r.cpp.ympe],
  ['cpp.yampe', (r) => r.cpp.yampe],
  ['ei.maxInsurable', (r) => r.ei.maxInsurable],
  ['onSurtaxBands[0]', (r) => r.onSurtaxBands[0].threshold],
  ['onSurtaxBands[1]', (r) => r.onSurtaxBands[1].threshold],
  ['medicalThresholdCap', (r) => r.medicalThresholdCap],
  ['rrspAnnualLimit', (r) => r.rrspAnnualLimit],
  ['dtcBaseFederal', (r) => r.dtcBaseFederal],
  ['dtcSupplementFederal', (r) => r.dtcSupplementFederal],
  ['dtcSupplementThreshold', (r) => r.dtcSupplementThreshold],
  ['dtcBaseOntario', (r) => r.dtcBaseOntario],
  ['caregiverAmountFederalInfirmAdult', (r) => r.caregiverAmountFederalInfirmAdult],
  ['caregiverThresholdFederal', (r) => r.caregiverThresholdFederal],
  ['pensionIncomeAmountCapOntario', (r) => r.pensionIncomeAmountCapOntario],
  ['oasClawbackThreshold', (r) => r.oasClawbackThreshold],
];

test('every indexed 2027 amount is the published 2026 value × the declared factor', () => {
  for (const [name, pick] of INDEXED_SCALARS) {
    const base = pick(RATES_2026).toString();
    assert.equal(pick(RATES_2027).toString(), indexed(base), `${name} (2026 base ${base})`);
  }
});

test('2027 federal spousal amount tracks the federal BPA', () => {
  assert.equal(RATES_2027.spousalAmountFederal.toString(), RATES_2027.basicPersonalAmountFederal.toString());
});

test('2027 EI premium rate is carried forward from 2026 (set annually, not indexed)', () => {
  assert.equal(RATES_2027.ei.employeeRate.toString(), RATES_2026.ei.employeeRate.toString());
});

test('2027 stays marked projected', () => {
  assert.equal(RATES_2027.provenance, 'projected');
});
