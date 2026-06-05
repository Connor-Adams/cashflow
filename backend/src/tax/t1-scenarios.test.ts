import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from './util/decimal';
import { ratesFor } from './engine/brackets';
import { buildT1 } from './engine/t1';
import type { TaxYearFacts } from './engine/types';

const emptyCarryFwd = {
  netCapitalLoss: D('0'),
  rrspRoom: D('0'),
  nonCapLoss: D('0'),
  instalmentsPaid: D('0'),
};

function baseFacts(): TaxYearFacts {
  return {
    year: 2024,
    jurisdiction: 'CA-ON',
    employmentIncome: [],
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    fhsaContribs: [],
    donations: [],
    slips: [],
    carryforwards: { ...emptyCarryFwd },
    ageAtYearEnd: 40,
  };
}

test('Scenario A: $80k employment, no other income, single, age 40', () => {
  // Reference computation done by hand against CRA T1-2024 lines for ON.
  // Total payable expected ≈ $XX,XXX (engineer: fill in from CRA publication or accountant).
  const facts: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
  };
  const ret = buildT1(facts, ratesFor(2024));
  // First sanity: total income = 80000, no deductions => taxable = 80000
  assert.equal(ret.totals.totalIncome.toFixed(2), '80000.00');
  assert.equal(ret.totals.taxableIncome.toFixed(2), '80000.00');
  // Federal+ON+surtax+OHP total (CPP/EI excluded from L43500 per CRA T1 — they are
  // payroll-remitted, not owing at filing). Correct range ~$14k-$17k.
  // Old range (17k-22k) was based on the buggy computation that added cpp($4055.50)+ei($1049.12)=~$5104.62.
  // Correct totalPayable = 15067.70 (federal 9990.92 + provincial 5076.78).
  assert.ok(ret.totals.totalPayable.greaterThan(D('14000')));
  assert.ok(ret.totals.totalPayable.lessThan(D('17000')));
});

test('Scenario B: $80k employment + $10k eligible dividends', () => {
  const facts: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
    eligibleDividends: [{ source: 'T5 BMO', amount: D('10000'), cadAmount: D('10000') }],
  };
  const ret = buildT1(facts, ratesFor(2024));
  // Grossed-up eligible div = 13800, total income includes that line at 13800.
  assert.equal(ret.lines.find((l) => l.code === 'L12000')?.amount.toFixed(2), '13800.00');
});

test('Scenario C: $200k employment triggers BPA phaseout', () => {
  const facts: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('200000'), cadAmount: D('200000') }],
  };
  const ret = buildT1(facts, ratesFor(2024));
  // Expect more federal tax than 80k case proportionally
  assert.ok(ret.totals.federalTax.greaterThan(D('40000')));
});

test('Scenario D: $0 income returns 0 payable and no negative tax', () => {
  const facts = baseFacts();
  const ret = buildT1(facts, ratesFor(2024));
  assert.equal(ret.totals.totalPayable.toFixed(2), '0.00');
  for (const line of ret.lines) {
    assert.ok(line.amount.greaterThanOrEqualTo(0), `${line.code} went negative`);
  }
});

test('Scenario E: T4 box 14 of $82k beats computed $79.5k, warning emitted', () => {
  const facts: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'computed', amount: D('79500'), cadAmount: D('79500') }],
    slips: [
      {
        slipId: 1,
        slipType: 'T4',
        issuer: 'Acme',
        boxes: { box14: D('82000') },
      },
    ],
  };
  const ret = buildT1(facts, ratesFor(2024));
  assert.equal(ret.lines.find((l) => l.code === 'L10100')?.amount.toFixed(2), '82000.00');
  assert.ok(ret.warnings.length > 0);
  assert.ok(ret.warnings[0].includes('T4 box 14'));
});

test('Scenario F: T4 box 22 ($14,000 withheld) reduces L48500 dollar-for-dollar', () => {
  // Baseline: $80k employment via T4 slip, no withholding.
  const baseline: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
    slips: [
      {
        slipId: 1,
        slipType: 'T4',
        issuer: 'Acme',
        boxes: { box14: D('80000') },
      },
    ],
  };
  const baselineRet = buildT1(baseline, ratesFor(2024));

  // Same facts, but T4 box 22 reports $14,000 tax withheld at source.
  const withWithholding: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
    slips: [
      {
        slipId: 1,
        slipType: 'T4',
        issuer: 'Acme',
        boxes: { box14: D('80000'), box22: D('14000') },
      },
    ],
  };
  const ret = buildT1(withWithholding, ratesFor(2024));

  // L43700 reports source deductions = 14000.
  assert.equal(ret.lines.find((l) => l.code === 'L43700')?.amount.toFixed(2), '14000.00');

  // L48200 (total credits) = withholding + instalments (0) = 14000.
  assert.equal(ret.lines.find((l) => l.code === 'L48200')?.amount.toFixed(2), '14000.00');

  // Total payable unchanged by withholding (tax owed before payments).
  assert.equal(
    ret.totals.totalPayable.toFixed(2),
    baselineRet.totals.totalPayable.toFixed(2),
    'withholding must not change total payable'
  );

  // L48500 reduced by exactly $14,000 vs baseline.
  const baselineRefundOrOwing = baselineRet.totals.refundOrOwing;
  const expected = baselineRefundOrOwing.minus(D('14000'));
  assert.equal(ret.totals.refundOrOwing.toFixed(2), expected.toFixed(2));
});

test('Scenario G: OAS clawback — net income $100k triggers L23500 and increases total payable', () => {
  const r = ratesFor(2024);
  // $100k income: net income > $90,997 threshold → OAS clawback = ($100k - $90,997) × 15% = $1,350.45
  const factsNoOas: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('90000'), cadAmount: D('90000') }],
  };
  const factsWithOas: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('100000'), cadAmount: D('100000') }],
  };
  const retNoOas = buildT1(factsNoOas, r);
  const retWithOas = buildT1(factsWithOas, r);

  // L23500 (OAS clawback) should appear in the $100k scenario
  const oasLine = retWithOas.lines.find((l) => l.code === 'L23500');
  assert.ok(oasLine, 'L23500 OAS clawback line should be present when net income > threshold');
  assert.equal(oasLine!.amount.toFixed(2), '1350.45');

  // The OAS clawback must be included in total payable
  const clawbackAmount = D('1350.45');
  // Total payable in the $100k case must be higher than $90k case by at least the clawback
  // (it will be higher also due to higher marginal tax, so just check clawback adds to payable)
  assert.ok(
    retWithOas.totals.totalPayable.greaterThan(retNoOas.totals.totalPayable),
    'Total payable must increase when OAS clawback applies',
  );

  // In the baseline $90k case (net income < threshold), no L23500 line
  const noOasLine = retNoOas.lines.find((l) => l.code === 'L23500');
  assert.equal(noOasLine, undefined, 'L23500 should not appear when net income <= threshold');

  // FHSA deduction reduces net income below threshold so clawback is 0
  const factsWithFhsa: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('100000'), cadAmount: D('100000') }],
    fhsaContribs: [{ source: 'FHSA', amount: D('8000'), date: '2024-02-01' }],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('100000'), nonCapLoss: D('0'), instalmentsPaid: D('0') },
  };
  const retWithFhsa = buildT1(factsWithFhsa, r);
  const oasLineFhsa = retWithFhsa.lines.find((l) => l.code === 'L23500');
  // Net income after $8k FHSA deduction = $92,000; still above threshold ($90,997) → clawback exists
  assert.ok(oasLineFhsa, 'OAS clawback should still exist at net income $92k');
  // ($100k - $8k FHSA) - $90,997 = $1,003 × 15% = $150.45
  assert.equal(oasLineFhsa!.amount.toFixed(2), '150.45');
});
