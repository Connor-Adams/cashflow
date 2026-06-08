import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { ratesFor } from './brackets';
import { computeCppEmployee, computeEiEmployee, computeCppSelfEmployed } from './cpp-ei';

test('CPP employee at $0 employment income = $0', () => {
  const r = ratesFor(2024);
  assert.equal(computeCppEmployee(D('0'), r).toFixed(2), '0.00');
});

test('CPP employee at $30k: (30000-3500) * 0.0595', () => {
  const r = ratesFor(2024);
  const exp = D('30000').minus('3500').times('0.0595');
  assert.equal(computeCppEmployee(D('30000'), r).toFixed(2), exp.toFixed(2));
});

test('CPP employee at YMPE+ caps base contribution + adds CPP2 up to YAMPE', () => {
  const r = ratesFor(2024); // YMPE 68500, YAMPE 73200
  const base = D('68500').minus('3500').times('0.0595');
  const cpp2 = D('73200').minus('68500').times('0.04');
  const expected = base.plus(cpp2);
  assert.equal(computeCppEmployee(D('80000'), r).toFixed(2), expected.toFixed(2));
});

test('EI employee at $30k: 30000 * 0.0166', () => {
  const r = ratesFor(2024);
  assert.equal(computeEiEmployee(D('30000'), r).toFixed(2), D('30000').times('0.0166').toFixed(2));
});

test('EI employee caps at maxInsurable', () => {
  const r = ratesFor(2024);
  assert.equal(computeEiEmployee(D('100000'), r).toFixed(2), D('63200').times('0.0166').toFixed(2));
});

test('computeCppSelfEmployed charges both halves (2× employee rate)', () => {
  const r = ratesFor(2025);
  // SE income $80,000 — above YMPE ($71,300), below YAMPE ($81,200)
  // Base CPP: (min(80000, 71300) - 3500) × 0.0595 = 67800 × 0.0595 = 4034.10
  // CPP2: (min(80000, 81200) - 71300) × 0.04 = 8700 × 0.04 = 348.00
  // Employee portion = 4034.10 + 348.00 = 4382.10
  // Self-employed = 2 × 4382.10 = 8764.20
  const result = computeCppSelfEmployed(D('80000'), r);
  assert.equal(result.toFixed(2), '8764.20');
});

test('computeCppSelfEmployed below basic exemption returns 0', () => {
  const r = ratesFor(2025);
  const result = computeCppSelfEmployed(D('3000'), r);
  assert.equal(result.toFixed(2), '0.00');
});

import { buildT1 } from './t1.js';
import type { TaxYearFacts } from './types.js';

test('buildT1 includes SE CPP in totalPayable and grants credit for employee half', () => {
  const r = ratesFor(2025);
  const facts: TaxYearFacts = {
    year: 2025,
    jurisdiction: 'CA-ON',
    employmentIncome: [],
    selfEmploymentIncome: [{ source: 'freelance', amount: D('80000'), cadAmount: D('80000') }],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    fhsaContribs: [],
    donations: [],
    slips: [],
    rentalIncome: [],
    rentalExpenses: [],
    medicalExpenses: [],
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('0'),
    },
    ageAtYearEnd: 35,
  };
  const ret = buildT1(facts, r);

  // SE CPP should be 8764.20 (both halves)
  assert.equal(ret.totals.cppContrib.toFixed(2), '8764.20');

  // SE CPP should appear in totalPayable
  const l31000 = ret.lines.find(l => l.code === 'L31000');
  assert.ok(l31000, 'L31000 SE CPP line present');
  assert.equal(l31000!.amount.toFixed(2), '8764.20');

  // Deductible half should reduce net income
  const l22200 = ret.lines.find(l => l.code === 'L22200');
  assert.ok(l22200, 'L22200 SE CPP deduction present');
  assert.equal(l22200!.amount.toFixed(2), '4382.10');
});
