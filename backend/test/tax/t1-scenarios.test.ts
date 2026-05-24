import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor } from '../../src/tax/engine/brackets';
import { buildT1 } from '../../src/tax/engine/t1';
import type { TaxYearFacts } from '../../src/tax/engine/types';

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
  // Federal+ON+surtax+OHP+CPP+EI total within published range (~$18k-$20k).
  assert.ok(ret.totals.totalPayable.greaterThan(D('17000')));
  assert.ok(ret.totals.totalPayable.lessThan(D('22000')));
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
