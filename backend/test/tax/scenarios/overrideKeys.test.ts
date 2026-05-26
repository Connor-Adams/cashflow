// backend/test/tax/scenarios/overrideKeys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../../src/tax/util/decimal';
import {
  overrideKeyRegistry, getOverrideKey, validateOverrideMap,
} from '../../../src/tax/scenarios/overrideKeys';
import type { TaxYearFacts } from '../../../src/tax/engine/types';

function emptyFacts(): TaxYearFacts {
  return {
    year: 2025, jurisdiction: 'CA-ON',
    employmentIncome: [], selfEmploymentIncome: [], selfEmploymentExpenses: [],
    interestIncome: [], eligibleDividends: [], nonEligibleDividends: [],
    capitalGainEvents: [], rrspContribs: [], fhsaContribs: [], donations: [],
    slips: [],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0') },
    ageAtYearEnd: 40,
  };
}

test('registry contains expected P7 personal keys', () => {
  const keys = overrideKeyRegistry.map((k) => k.key);
  assert.ok(keys.includes('income.employment'));
  assert.ok(keys.includes('income.eligibleDividends'));
  assert.ok(keys.includes('income.nonEligibleDividends'));
  assert.ok(keys.includes('income.interest'));
  assert.ok(keys.includes('deductions.rrspContrib'));
  assert.ok(keys.includes('deductions.fhsaContrib'));
  assert.ok(keys.includes('deductions.donations'));
  assert.ok(keys.includes('capgains.dispositions'));
});

test('getOverrideKey returns the entry for a known key', () => {
  const entry = getOverrideKey('income.employment');
  assert.equal(entry?.label, 'Employment income (CAD)');
});

test('getOverrideKey returns undefined for an unknown key', () => {
  assert.equal(getOverrideKey('not.a.real.key'), undefined);
});

test('validateOverrideMap throws on unknown key', () => {
  assert.throws(
    () => validateOverrideMap({ 'totally.fake': 1 }),
    /unknown override key/i,
  );
});

test('validateOverrideMap throws when value fails per-key validator', () => {
  assert.throws(
    () => validateOverrideMap({ 'income.employment': 'not a number' }),
    /income.employment/,
  );
});

test('apply: income.employment replaces aggregated employment income', () => {
  const entry = getOverrideKey('income.employment')!;
  entry.validate(95000);
  const facts = entry.apply(emptyFacts(), 95000);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '95000.00');
  assert.equal(facts.employmentIncome[0].source, 'override:income.employment');
});

test('apply: capgains.dispositions appends events to capitalGainEvents', () => {
  const entry = getOverrideKey('capgains.dispositions')!;
  const dispositions = [
    { proceeds: 100000, acb: 60000, date: '2025-03-15' },
    { proceeds: 50000, acb: 40000, date: '2025-09-01' },
  ];
  entry.validate(dispositions);
  const facts = entry.apply(emptyFacts(), dispositions);
  assert.equal(facts.capitalGainEvents.length, 2);
  assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '100000.00');
  assert.equal(facts.capitalGainEvents[1].acb.toFixed(2), '40000.00');
});
