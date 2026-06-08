// backend/test/tax/scenarios/corpOverrideKeys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { getOverrideKey, getOverrideKeysForKind, validateOverrideMap } from './overrideKeys';
import './corpOverrideKeys'; // side-effect: registers corp keys
import type { CorpTaxYearFacts } from '../engine/types';

function emptyCorpFacts(): CorpTaxYearFacts {
  return {
    fiscalYear: { startDate: '2025-01-01', endDate: '2025-12-31' },
    jurisdiction: 'CA-ON',
    activeBusinessIncome: [],
    investmentIncome: { interest: [], eligibleDividends: [], nonEligibleDividends: [], rentNet: [] },
    capitalGainEvents: [],
    dividendsPaid: [],
    salaryPaid: D('0'),
    carryforwards: { grip: D('0'), cda: D('0'), erdtoh: D('0'), nerdtoh: D('0'), nonCapLoss: D('0'), netCapitalLoss: D('0') },
  };
}

test('corp registry exposes 8 P8a keys', () => {
  const keys = getOverrideKeysForKind('corp').map((k) => k.key);
  assert.ok(keys.includes('corp.activeIncome'));
  assert.ok(keys.includes('corp.passiveInvestmentIncome'));
  assert.ok(keys.includes('corp.aaiiTrailing'));
  assert.ok(keys.includes('corp.dividendsPaidEligible'));
  assert.ok(keys.includes('corp.dividendsPaidNonEligible'));
  assert.ok(keys.includes('corp.salaryPaid'));
  assert.ok(keys.includes('corp.openingGrip'));
  assert.ok(keys.includes('corp.openingCda'));
});

test('all corp keys have kind=corp', () => {
  for (const entry of getOverrideKeysForKind('corp')) {
    assert.equal(entry.kind, 'corp');
  }
});

test('validateOverrideMap accepts a corp key on a corp scenario', () => {
  validateOverrideMap({ 'corp.activeIncome': 250000 }, 'corp'); // should not throw
});

test('validateOverrideMap rejects a corp key on a personal scenario', () => {
  assert.throws(
    () => validateOverrideMap({ 'corp.activeIncome': 250000 }, 'personal'),
    /corp scenarios/,
  );
});

test('apply: corp.activeIncome replaces activeBusinessIncome array', () => {
  const entry = getOverrideKey('corp.activeIncome')!;
  const result = entry.apply(emptyCorpFacts() as unknown as never, 250000) as unknown as CorpTaxYearFacts;
  assert.equal(result.activeBusinessIncome.length, 1);
  assert.equal(result.activeBusinessIncome[0].cadAmount.toFixed(2), '250000.00');
});

test('apply: corp.salaryPaid replaces salaryPaid Decimal', () => {
  const entry = getOverrideKey('corp.salaryPaid')!;
  const result = entry.apply(emptyCorpFacts() as unknown as never, 60000) as unknown as CorpTaxYearFacts;
  assert.equal(result.salaryPaid.toFixed(2), '60000.00');
});

test('apply: corp.dividendsPaidEligible appends one dividend item', () => {
  const entry = getOverrideKey('corp.dividendsPaidEligible')!;
  const result = entry.apply(emptyCorpFacts() as unknown as never, 80000) as unknown as CorpTaxYearFacts;
  assert.equal(result.dividendsPaid.length, 1);
  assert.equal(result.dividendsPaid[0].kind, 'eligible');
  assert.equal(result.dividendsPaid[0].amount.toFixed(2), '80000.00');
});

test('apply: corp.openingGrip overrides carryforward', () => {
  const entry = getOverrideKey('corp.openingGrip')!;
  const result = entry.apply(emptyCorpFacts() as unknown as never, 50000) as unknown as CorpTaxYearFacts;
  assert.equal(result.carryforwards.grip.toFixed(2), '50000.00');
});
