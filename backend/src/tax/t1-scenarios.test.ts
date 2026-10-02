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
  fhsaLifetimeContributions: D('0'), fhsaRoom: D('0'),
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

/**
 * Scenario A pinned exactly, and what that does and does not prove.
 *
 * The assertion used to be `> $14,000 && < $17,000`. A $3,000 band is why a whole
 * table of wrong 2026 constants survived: nothing failed when they were wrong, so
 * nothing failed when they were corrected either. An exact value fails on any
 * change to a constant or to the credit set, which forces a re-derivation instead
 * of a shrug.
 *
 * What it proves: the COMPOSITION is stable — bracket application, BPA, the
 * CPP/EI credits, the Ontario surtax ordering and the health premium still
 * combine the way they did. What it does not prove: that the constants match CRA.
 * That claim belongs to `rates-2026.test.ts`, which asserts each published figure
 * one per case so a regression names the value. Two different jobs; neither
 * substitutes for the other, and pretending this test verifies CRA figures would
 * be the same mistake in a new place.
 *
 * Components are asserted separately so a failure localises to federal, Ontario,
 * or the health premium rather than reporting one moved total.
 */
function scenarioA(year: number) {
  const facts: TaxYearFacts = {
    ...baseFacts(),
    year,
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
  };
  return buildT1(facts, ratesFor(year));
}

test('Scenario A 2024: $80k employment, single, age 40', () => {
  const ret = scenarioA(2024);
  assert.equal(ret.totals.totalIncome.toFixed(2), '80000.00');
  // Enhanced CPP is deducted on L22215: 1% of (68,500 − 3,500) + CPP2 4% of
  // (73,200 − 68,500) = 650 + 188. Only base CPP remains in the credit.
  assert.equal(ret.lines.find((l) => l.code === 'L22215')?.amount.toFixed(2), '838.00');
  assert.equal(ret.totals.taxableIncome.toFixed(2), '79162.00');
  // Federal + ON + surtax + OHP. CPP and EI are excluded from L43500 per the CRA
  // T1: they are payroll-remitted, not owing at filing. The band this replaces
  // had been widened once already to accommodate a bug that added
  // cpp(4055.50) + ei(1049.12) here.
  assert.equal(ret.lines.find((l) => l.code === 'L42000')?.amount.toFixed(2), '9944.83');
  // L42800 is Ontario tax before the health premium; the premium is $750 at $80k,
  // which is the whole of the 14,987.26 - 9,944.83 - 4,292.42 remainder (rounded).
  assert.equal(ret.lines.find((l) => l.code === 'L42800')?.amount.toFixed(2), '4292.42');
  assert.equal(ret.totals.totalPayable.toFixed(2), '14987.26');
});

test('Scenario A 2026: the same taxpayer against the published table', () => {
  // The year Connor is actually exposed in, and the only one whose table is
  // marked provenance: 'published'. 2024 is encoded from recall (see
  // rates-2024.ts), so pinning it is a regression lock and nothing more; this
  // case is a claim about numbers that were checked.
  const ret = scenarioA(2026);
  // 80,000 less L22215 enhanced CPP: 1% × (74,600 − 3,500) + 4% × (80,000 − 74,600).
  assert.equal(ret.totals.taxableIncome.toFixed(2), '79073.00');
  assert.equal(ret.lines.find((l) => l.code === 'L42000')?.amount.toFixed(2), '9242.60');
  assert.equal(ret.lines.find((l) => l.code === 'L42800')?.amount.toFixed(2), '4135.26');
  assert.equal(ret.totals.totalPayable.toFixed(2), '14127.85');
});

test('indexation lowers tax on a constant nominal income, 2024 through 2026', () => {
  // Cheap, and it catches a class of constant errors an exact pin does not name:
  // a transposed digit that SHRINKS a bracket raises tax on a fixed $80k, and
  // three independently-pinned totals would each just be "the new expected value".
  // A monotone direction is a property, not a snapshot.
  const totals = [2024, 2025, 2026].map((y) => scenarioA(y).totals.totalPayable);
  assert.ok(totals[0].greaterThan(totals[1]), `2024 ${totals[0]} should exceed 2025 ${totals[1]}`);
  assert.ok(totals[1].greaterThan(totals[2]), `2025 ${totals[1]} should exceed 2026 ${totals[2]}`);
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
  assert.ok(ret.warnings[0].includes('T4 net pay'));
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

  // Senior receiving $8,500 OAS: total income $108,500 less $838 enhanced CPP
  // (L22215, computed — no T4) = $107,662 net income.
  // clawback = min($8,500, ($107,662 - $90,997) × 15%) = $2,499.75
  const factsWithOas: TaxYearFacts = {
    ...baseFacts(),
    ageAtYearEnd: 72,
    employmentIncome: [
      { source: 'pension draw', amount: D('100000'), cadAmount: D('100000') },
    ],
    oasBenefits: D('8500'),
  };
  const retWithOas = buildT1(factsWithOas, r);
  const oasLine = retWithOas.lines.find((l) => l.code === 'L23500');
  assert.ok(oasLine, 'L23500 OAS clawback line should be present when net income > threshold');
  assert.equal(oasLine!.amount.toFixed(2), '2499.75');
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
    ],
    oasBenefits: D('8500'),
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
    ],
    oasBenefits: D('8500'),
    fhsaContribs: [{ source: 'FHSA', amount: D('8000'), date: '2024-02-01' }],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('100000'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0'), fhsaRoom: D('0') },
  };
  const retWithFhsa = buildT1(factsWithFhsa, r);
  const oasLineFhsa = retWithFhsa.lines.find((l) => l.code === 'L23500');
  // Net income after $8k FHSA and $838 enhanced CPP = $91,162; still above the
  // $90,997 threshold → clawback exists: $165 × 15% = $24.75
  assert.ok(oasLineFhsa, 'OAS clawback should still exist at net income $91,162');
  assert.equal(oasLineFhsa!.amount.toFixed(2), '24.75');
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
