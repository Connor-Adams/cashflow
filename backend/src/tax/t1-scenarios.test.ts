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
  fhsaLifetimeContributions: D('0'),
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
    rentalIncome: [],
    rentalExpenses: [],
    medicalExpenses: [],
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

test('Scenario G: OAS clawback — only applies to OAS actually received, capped at benefits', () => {
  const r = ratesFor(2024);

  // High income but NO OAS received (e.g. age 40) → no repayment, no L23500.
  const factsNoOas: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('100000'), cadAmount: D('100000') }],
  };
  const retNoOas = buildT1(factsNoOas, r);
  assert.equal(
    retNoOas.lines.find((l) => l.code === 'L23500'),
    undefined,
    'L23500 must not appear for a taxpayer who received no OAS',
  );

  // Senior receiving $8,500 OAS with $108,500 net income:
  // clawback = min($8,500, ($108,500 - $90,997) × 15%) = min(8500, 2625.45) = $2,625.45
  const factsWithOas: TaxYearFacts = {
    ...baseFacts(),
    ageAtYearEnd: 72,
    employmentIncome: [
      { source: 'pension draw', amount: D('100000'), cadAmount: D('100000') },
      { source: 'OAS', amount: D('8500'), cadAmount: D('8500') },
    ],
    oasIncome: D('8500'),
  };
  const retWithOas = buildT1(factsWithOas, r);
  const oasLine = retWithOas.lines.find((l) => l.code === 'L23500');
  assert.ok(oasLine, 'L23500 OAS clawback line should be present when net income > threshold');
  assert.equal(oasLine!.amount.toFixed(2), '2625.45');
  assert.ok(
    retWithOas.totals.totalPayable.greaterThan(retNoOas.totals.totalPayable),
    'Total payable must increase when OAS clawback applies',
  );

  // Repayment is capped at the OAS received: $208,500 net income → 15% of
  // excess is $17,625.45 but only $8,500 of OAS was received.
  const factsCapped: TaxYearFacts = {
    ...baseFacts(),
    ageAtYearEnd: 72,
    employmentIncome: [
      { source: 'pension draw', amount: D('200000'), cadAmount: D('200000') },
      { source: 'OAS', amount: D('8500'), cadAmount: D('8500') },
    ],
    oasIncome: D('8500'),
  };
  const retCapped = buildT1(factsCapped, r);
  const cappedLine = retCapped.lines.find((l) => l.code === 'L23500');
  assert.ok(cappedLine, 'L23500 should be present');
  assert.equal(cappedLine!.amount.toFixed(2), '8500.00');

  // FHSA deduction reduces net income, shrinking the clawback.
  const factsWithFhsa: TaxYearFacts = {
    ...baseFacts(),
    ageAtYearEnd: 72,
    employmentIncome: [
      { source: 'pension draw', amount: D('91500'), cadAmount: D('91500') },
      { source: 'OAS', amount: D('8500'), cadAmount: D('8500') },
    ],
    oasIncome: D('8500'),
    fhsaContribs: [{ source: 'FHSA', amount: D('8000'), date: '2024-02-01' }],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('100000'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0') },
  };
  const retWithFhsa = buildT1(factsWithFhsa, r);
  const oasLineFhsa = retWithFhsa.lines.find((l) => l.code === 'L23500');
  // Net income after $8k FHSA deduction = $92,000; still above threshold ($90,997) → clawback exists
  assert.ok(oasLineFhsa, 'OAS clawback should still exist at net income $92k');
  // ($100k - $8k FHSA) - $90,997 = $1,003 × 15% = $150.45
  assert.equal(oasLineFhsa!.amount.toFixed(2), '150.45');
});

test('Scenario H: ON surtax computed before the Ontario dividend tax credit (ON428 ordering)', () => {
  const r = ratesFor(2024);
  // $200,000 actual eligible dividends, nothing else → grossed-up $276,000.
  // ON tax before credits on $276,000 (2024 ON brackets) = $28,444.1446
  // − ON BPA credit $12,399 × 0.0505 = $626.1495 → $27,817.9951 pre-DTC.
  // Surtax (on the PRE-DTC amount, per ON428 since 2014):
  //   0.20 × (27,817.9951 − 5,554) + 0.36 × (27,817.9951 − 7,108) = $11,908.397256
  // ON DTC = $276,000 × 0.10 = $27,600, applied AFTER surtax:
  //   net ON tax = 27,817.9951 + 11,908.397256 − 27,600 = $12,126.39
  // The buggy ordering (DTC before surtax) leaves only $217.9951 of ON tax and
  // zero surtax.
  const facts: TaxYearFacts = {
    ...baseFacts(),
    eligibleDividends: [{ source: 'T5 holdco', amount: D('200000'), cadAmount: D('200000') }],
  };
  const ret = buildT1(facts, r);

  const surtaxLine = ret.lines.find((l) => l.code === 'L42801');
  assert.ok(surtaxLine, 'L42801 ON surtax line should be present');
  assert.equal(surtaxLine!.amount.toFixed(2), '11908.40');

  // provincialTax = net ON tax (incl. surtax, net of DTC) + OHP ($900 at this income)
  const expectedProvincial = D('12126.392356').plus(D('900'));
  assert.equal(ret.totals.provincialTax.toFixed(2), expectedProvincial.toFixed(2));
});
