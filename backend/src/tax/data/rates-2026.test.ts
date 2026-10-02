import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATES_2026 } from './rates-2026';

// Bill C-4 (Royal Assent 2025-06-26) cut the lowest federal personal rate from
// 15% to 14% effective 2025-07-01. 2025 blends to 14.5%; 2026 is the first
// full year at 14%. The credit "appropriate percentage" (ITA s.248(1)) drops
// with it, so credits valued at the lowest rate use 14% too.
test('2026 lowest federal bracket rate is 14% (Bill C-4, first full year)', () => {
  assert.equal(RATES_2026.federalBrackets[0].rate.toString(), '0.14');
});

test('2026 appropriate percentage (donationLowRate) is 14%', () => {
  assert.equal(RATES_2026.donationLowRate.toString(), '0.14');
});

// ---------------------------------------------------------------------------
// Published 2026 figures, one case per value so a regression names the value.
//
// The file this checks used to carry a "VERIFIED" header over an indexation
// PROJECTION written before CRA published anything: every indexed constant was
// wrong, Ontario amounts were stale by one or two years, and it carried a
// capital-gains tier that had been cancelled. Sources: CRA indexation table for
// 2026, Service Canada CPP/EI 2026, Ontario Finance / TD1ON 2026.
// ---------------------------------------------------------------------------

const FEDERAL: [string, string][] = [
  ['bracket 1 upTo', '58523'],
  ['bracket 2 upTo', '117045'],
  ['bracket 3 upTo', '181440'],
  ['bracket 4 upTo', '258482'],
];

test('2026 federal bracket thresholds are the published amounts', () => {
  FEDERAL.forEach(([label, expected], i) => {
    assert.equal(RATES_2026.federalBrackets[i].upTo?.toString(), expected, label);
  });
  assert.equal(RATES_2026.federalBrackets[4].upTo, null, 'top bracket is open-ended');
});

test('2026 Ontario bracket thresholds are the published amounts', () => {
  assert.equal(RATES_2026.provincialBrackets[0].upTo?.toString(), '53891');
  assert.equal(RATES_2026.provincialBrackets[1].upTo?.toString(), '107785');
  // Ontario does not index its top two thresholds — these are statutory.
  assert.equal(RATES_2026.provincialBrackets[2].upTo?.toString(), '150000');
  assert.equal(RATES_2026.provincialBrackets[3].upTo?.toString(), '220000');
});

const SCALARS: [string, keyof typeof RATES_2026, string][] = [
  ['federal BPA', 'basicPersonalAmountFederal', '16452'],
  ['federal BPA floor', 'bpaFederalMin', '14829'],
  ['BPA phaseout start', 'bpaFederalPhaseoutStart', '181440'],
  ['BPA phaseout end', 'bpaFederalPhaseoutEnd', '258482'],
  ['Ontario BPA', 'basicPersonalAmountOntario', '12989'],
  ['federal age amount', 'ageAmountFederal', '9208'],
  ['federal age threshold', 'ageAmountFederalThreshold', '46432'],
  ['Canada employment amount', 'employmentAmountFederal', '1501'],
  ['medical 3% cap', 'medicalThresholdCap', '2890'],
  ['RRSP dollar limit', 'rrspAnnualLimit', '33810'],
  ['OAS recovery threshold', 'oasClawbackThreshold', '95323'],
];

test('2026 Ontario surtax bands are the published thresholds', () => {
  assert.equal(RATES_2026.onSurtaxBands[0].threshold.toString(), '5818');
  assert.equal(RATES_2026.onSurtaxBands[1].threshold.toString(), '7446');
});

test('2026 indexed scalar amounts are the published amounts', () => {
  for (const [label, key, expected] of SCALARS) {
    const got = RATES_2026[key] as unknown as { toString(): string };
    assert.equal(got.toString(), expected, label);
  }
});

const CPP_EI: [string, string][] = [
  ['YMPE', '74600'],
  ['YAMPE', '85000'],
];

test('2026 CPP and EI are the published amounts', () => {
  assert.equal(RATES_2026.cpp.ympe.toString(), CPP_EI[0][1]);
  assert.equal(RATES_2026.cpp.yampe.toString(), CPP_EI[1][1]);
  assert.equal(RATES_2026.cpp.basicExemption.toString(), '3500');
  assert.equal(RATES_2026.cpp.employeeRate.toString(), '0.0595');
  assert.equal(RATES_2026.cpp.cpp2Rate.toString(), '0.04');
  // EI's rate FELL for 2026 — indexation would project the wrong direction.
  assert.equal(RATES_2026.ei.maxInsurable.toString(), '68900');
  assert.equal(RATES_2026.ei.employeeRate.toString(), '0.0163');
});

test('2026 has no high capital-gains inclusion tier — the increase was cancelled', () => {
  // Budget 2024 proposed 66.67% above $250,000, deferred to 2026-01-01, then
  // cancelled outright on 2025-03-21 and legislated dead in Budget 2025. The
  // field is retained at 0.5 rather than removed because t2.ts, integration.ts
  // and aaii.ts read it as the CORPORATE inclusion rate with a
  // `?? capitalGainsInclusion` fallback — and 50% is now correct there too.
  assert.equal(RATES_2026.capitalGainsInclusion.toString(), '0.5');
  assert.equal(RATES_2026.capitalGainsInclusionHigh?.toString(), '0.5');
});

test('2026 AMT exemption tracks the start of the 4th federal bracket', () => {
  // Derived rather than stored, so the two cannot drift apart.
  assert.equal(
    RATES_2026.amtExemption.toString(),
    RATES_2026.federalBrackets[2].upTo?.toString(),
  );
});

test('the 2026 table declares itself published, not projected', () => {
  // The original failure was a header claiming more than the body delivered.
  // Provenance is a field so the return route can refuse a projection for a
  // closed year rather than trusting a comment.
  assert.equal(RATES_2026.provenance, 'published');
});

// Values the table once carried as placeholders ("2025 value reused", "×1.027
// PROJECTED") under a `published` banner — some of them below the 2025 figures.
// Sources: CRA Form TD1ON 2026 (td1on-26e.pdf), CRA Form TD1 2026 (td1-26e.pdf),
// and CRA "Indexation adjustment for personal income tax and benefit amounts".
const PLACEHOLDERS_REPLACED: [string, keyof typeof RATES_2026, string][] = [
  ['Ontario age amount', 'ageAmountOntario', '6342'],
  ['Ontario age threshold', 'ageAmountOntarioThreshold', '47210'],
  ['Ontario pension income amount', 'pensionIncomeAmountCapOntario', '1796'],
  ['Ontario disability amount', 'dtcBaseOntario', '10494'],
  ['federal disability amount', 'dtcBaseFederal', '10341'],
  ['federal disability supplement', 'dtcSupplementFederal', '6032'],
  ['federal disability supplement care threshold', 'dtcSupplementThreshold', '3533'],
  ['federal caregiver amount (infirm 18+)', 'caregiverAmountFederalInfirmAdult', '8773'],
  ['federal caregiver reduction threshold', 'caregiverThresholdFederal', '20601'],
];

test('2026 formerly-placeholder credit amounts are the published amounts', () => {
  for (const [label, key, expected] of PLACEHOLDERS_REPLACED) {
    const got = RATES_2026[key] as unknown as { toString(): string };
    assert.equal(got.toString(), expected, label);
  }
});
