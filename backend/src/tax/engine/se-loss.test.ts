import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal.js';
import { ratesFor } from './brackets.js';
import { buildT1 } from './t1.js';
import type { TaxYearFacts } from './types.js';

const r = ratesFor(2025);

function baseFacts(overrides: Partial<TaxYearFacts> = {}): TaxYearFacts {
  return {
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
    ageAtYearEnd: 30,
    ...overrides,
  };
}

test('SE loss reduces total income below employment income', () => {
  const noSE = buildT1(baseFacts(), r);
  const withSELoss = buildT1(baseFacts({
    selfEmploymentExpenses: [{ source: 'laptop', amount: D('4000'), cadAmount: D('4000') }],
  }), r);

  assert.ok(
    withSELoss.totals.totalIncome.lessThan(noSE.totals.totalIncome),
    `SE loss should reduce total income: got ${withSELoss.totals.totalIncome.toFixed(2)} vs ${noSE.totals.totalIncome.toFixed(2)}`
  );
  assert.equal(
    withSELoss.totals.totalIncome.toFixed(2),
    '46000.00',
    'total income should be 50000 - 4000 = 46000'
  );
});

test('SE loss reduces tax payable', () => {
  const noSE = buildT1(baseFacts(), r);
  const withSELoss = buildT1(baseFacts({
    selfEmploymentExpenses: [{ source: 'laptop', amount: D('4000'), cadAmount: D('4000') }],
  }), r);

  assert.ok(
    withSELoss.totals.totalPayable.lessThan(noSE.totals.totalPayable),
    'SE loss should reduce total tax payable'
  );
});

test('SE net income is negative when expenses exceed revenue', () => {
  const result = buildT1(baseFacts({
    selfEmploymentIncome: [{ source: 'consulting', amount: D('1000'), cadAmount: D('1000') }],
    selfEmploymentExpenses: [{ source: 'laptop', amount: D('5000'), cadAmount: D('5000') }],
  }), r);

  const seLine = result.lines.find(l => l.code === 'L13500');
  assert.ok(seLine, 'L13500 should exist');
  assert.equal(seLine.amount.toFixed(2), '-4000.00', 'SE net should be -4000 (1000 - 5000)');
});

test('SE loss with zero revenue still reduces total income', () => {
  const result = buildT1(baseFacts({
    selfEmploymentExpenses: [{ source: 'hosting', amount: D('2000'), cadAmount: D('2000') }],
  }), r);

  assert.equal(
    result.totals.totalIncome.toFixed(2),
    '48000.00',
    'total income should be 50000 - 2000 = 48000'
  );
});
