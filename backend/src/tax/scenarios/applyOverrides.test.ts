// backend/test/tax/scenarios/applyOverrides.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { applyOverrides } from './applyOverrides';
import type { TaxYearFacts } from '../engine/types';

function emptyFacts(): TaxYearFacts {
  return {
    year: 2025, jurisdiction: 'CA-ON',
    employmentIncome: [], selfEmploymentIncome: [], selfEmploymentExpenses: [],
    interestIncome: [], eligibleDividends: [], nonEligibleDividends: [],
    capitalGainEvents: [], rrspContribs: [], fhsaContribs: [], donations: [],
    rentalIncome: [], rentalExpenses: [], medicalExpenses: [],
    slips: [],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0') },
    ageAtYearEnd: 40,
  };
}

test('empty override map returns input unchanged (referentially identical not required)', () => {
  const facts = emptyFacts();
  const result = applyOverrides(facts, [{}], 'personal');
  assert.deepEqual(result.employmentIncome, []);
  assert.equal(result.year, 2025);
});

test('single override replaces employment income', () => {
  const result = applyOverrides(emptyFacts(), [{ 'income.employment': 95000 }], 'personal');
  assert.equal(result.employmentIncome.length, 1);
  assert.equal(result.employmentIncome[0].cadAmount.toFixed(2), '95000.00');
});

test('later override wins for replace-style keys', () => {
  const result = applyOverrides(emptyFacts(), [
    { 'income.employment': 95000 },
    { 'income.employment': 120000 },
  ], 'personal');
  assert.equal(result.employmentIncome.length, 1);
  assert.equal(result.employmentIncome[0].cadAmount.toFixed(2), '120000.00');
});

test('append-style keys accumulate across maps', () => {
  const result = applyOverrides(emptyFacts(), [
    { 'capgains.dispositions': [{ proceeds: 100000, acb: 60000, date: '2025-03-15' }] },
    { 'capgains.dispositions': [{ proceeds: 50000, acb: 40000, date: '2025-09-01' }] },
  ], 'personal');
  assert.equal(result.capitalGainEvents.length, 2);
});

test('unknown key in a map throws', () => {
  assert.throws(
    () => applyOverrides(emptyFacts(), [{ 'totally.fake': 1 }], 'personal'),
    /unknown override key/i,
  );
});
