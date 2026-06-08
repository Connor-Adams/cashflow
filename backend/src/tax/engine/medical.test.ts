import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal.js';
import { ratesFor } from './brackets.js';
import { medicalCreditFederal } from './credits.js';
import { buildT1 } from './t1.js';
import type { TaxYearFacts } from './types.js';

test('medicalCreditFederal computes correctly for $5000 expenses at $60k income', () => {
  const r = ratesFor(2025);
  // threshold = min(60000 × 0.03, 2834) = min(1800, 2834) = 1800
  // eligible = 5000 - 1800 = 3200
  // credit = 3200 × 0.145 = 464 (2025 blended lowest rate per Bill C-4)
  const credit = medicalCreditFederal(D('5000'), D('60000'), r);
  assert.equal(credit.toFixed(2), '464.00');
});

test('buildT1 applies medical credit to federal tax', () => {
  const r = ratesFor(2025);
  const baseFacts: TaxYearFacts = {
    year: 2025,
    jurisdiction: 'CA-ON',
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    fhsaContribs: [],
    donations: [],
    slips: [{ slipId: 1, slipType: 'T4', issuer: 'Employer', boxes: { box14: D('80000'), box22: D('15000') } }],
    rentalIncome: [],
    rentalExpenses: [],
    medicalExpenses: [],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0') },
    ageAtYearEnd: 35,
  };

  const withoutMedical = buildT1(baseFacts, r);
  const withMedical = buildT1({
    ...baseFacts,
    medicalExpenses: [{ source: 'Rx', amount: D('5000'), cadAmount: D('5000') }],
  }, r);

  // Federal tax should be lower with medical expenses
  assert.ok(
    withMedical.totals.federalTax.lessThan(withoutMedical.totals.federalTax),
    'medical expenses should reduce federal tax'
  );
  // Ontario tax should also be lower
  assert.ok(
    withMedical.totals.provincialTax.lessThan(withoutMedical.totals.provincialTax),
    'medical expenses should reduce provincial tax'
  );
});
