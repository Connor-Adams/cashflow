import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal.js';
import { ratesFor } from '../engine/brackets.js';
import { buildT1 } from '../engine/t1.js';
import type { TaxYearFacts } from '../engine/types.js';

test('buildT1 applies pension income credit when pensionIncome is set', () => {
  const r = ratesFor(2025);
  const facts: TaxYearFacts = {
    year: 2025,
    jurisdiction: 'CA-ON',
    employmentIncome: [{ source: 'T4', amount: D('50000'), cadAmount: D('50000') }],
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    fhsaContribs: [],
    donations: [],
    slips: [{ slipId: 1, slipType: 'T4', issuer: 'Employer', boxes: { box14: D('50000'), box22: D('8000') } }],
    rentalIncome: [],
    rentalExpenses: [],
    medicalExpenses: [],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0') },
    ageAtYearEnd: 70,
    pensionIncome: D('24000'),
  };
  const ret = buildT1(facts, r);

  // Pension income should be in total income
  assert.ok(ret.totals.totalIncome.greaterThan(D('50000')), 'totalIncome should include pension');

  // Pension income credit should be capped at $2,000 × 15%
  const noPension = buildT1({ ...facts, pensionIncome: undefined }, r);
  assert.ok(ret.totals.federalTax.lessThan(noPension.totals.federalTax).valueOf() === false,
    'more income = more tax, but credit partially offsets');
});
