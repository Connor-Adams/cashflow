import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal.js';
import { ratesFor } from './brackets.js';
import { buildT1 } from './t1.js';
import type { TaxYearFacts } from './types.js';

test('buildT1 includes net rental income in total income', () => {
  const r = ratesFor(2025);
  const facts: TaxYearFacts = {
    year: 2025,
    jurisdiction: 'CA-ON',
    employmentIncome: [{ source: 'T4', amount: D('60000'), cadAmount: D('60000') }],
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    fhsaContribs: [],
    donations: [],
    slips: [{ slipId: 1, slipType: 'T4', issuer: 'Employer', boxes: { box14: D('60000'), box22: D('12000') } }],
    rentalIncome: [{ source: 'Rental unit A', amount: D('24000'), cadAmount: D('24000') }],
    rentalExpenses: [{ source: 'Mortgage interest', amount: D('8000'), cadAmount: D('8000') }],
    medicalExpenses: [],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0') },
    ageAtYearEnd: 40,
  };
  const ret = buildT1(facts, r);

  // Net rental = 24000 - 8000 = 16000
  const l12600 = ret.lines.find(l => l.code === 'L12600');
  assert.ok(l12600, 'L12600 rental income line present');
  assert.equal(l12600!.amount.toFixed(2), '16000.00');

  // Total income should be 60000 + 16000 = 76000
  assert.equal(ret.totals.totalIncome.toFixed(2), '76000.00');
});

test('buildT1 net rental income can be negative (rental loss reduces income)', () => {
  const r = ratesFor(2025);
  const facts: TaxYearFacts = {
    year: 2025,
    jurisdiction: 'CA-ON',
    employmentIncome: [{ source: 'T4', amount: D('60000'), cadAmount: D('60000') }],
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    fhsaContribs: [],
    donations: [],
    slips: [{ slipId: 1, slipType: 'T4', issuer: 'Employer', boxes: { box14: D('60000'), box22: D('12000') } }],
    rentalIncome: [{ source: 'Rental', amount: D('10000'), cadAmount: D('10000') }],
    rentalExpenses: [{ source: 'Repairs', amount: D('15000'), cadAmount: D('15000') }],
    medicalExpenses: [],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0') },
    ageAtYearEnd: 40,
  };
  const ret = buildT1(facts, r);

  const l12600 = ret.lines.find(l => l.code === 'L12600');
  assert.ok(l12600, 'L12600 present');
  // Net = 10000 - 15000 = -5000 — rental loss
  assert.equal(l12600!.amount.toFixed(2), '-5000.00');
});
