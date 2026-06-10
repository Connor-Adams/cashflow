// backend/test/tax/scenarios/overrideKeys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import {
  overrideKeyRegistry, getOverrideKey, getOverrideKeysForKind, validateOverrideMap,
} from './overrideKeys';
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
    () => validateOverrideMap({ 'totally.fake': 1 }, 'personal'),
    /unknown override key/i,
  );
});

test('validateOverrideMap throws when value fails per-key validator', () => {
  assert.throws(
    () => validateOverrideMap({ 'income.employment': 'not a number' }, 'personal'),
    /income.employment/,
  );
});

test('all existing P7 keys have kind=personal', () => {
  for (const entry of getOverrideKeysForKind('personal')) {
    assert.equal(entry.kind, 'personal', `${entry.key} should be tagged personal`);
  }
});

test('validateOverrideMap rejects a personal key on a corp scenario', () => {
  assert.throws(
    () => validateOverrideMap({ 'income.employment': 95000 }, 'corp'),
    /personal scenarios/,
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

test('registry contains P10 spouse-split personal keys', () => {
  const keys = overrideKeyRegistry.map((k) => k.key);
  assert.ok(keys.includes('deductions.spousalRrspContrib'));
  assert.ok(keys.includes('pensionSplit.transferAmount'));
});

test('apply: deductions.spousalRrspContrib appends an RRSP contrib with spousal source tag', () => {
  const entry = getOverrideKey('deductions.spousalRrspContrib')!;
  assert.equal(entry.kind, 'personal');
  entry.validate(8000);
  // Seed with an existing personal RRSP contrib to verify spousal appends rather than replaces.
  const base = emptyFacts();
  base.rrspContribs = [{ source: 'override:deductions.rrspContrib', amount: D('5000'), date: '' }];
  const facts = entry.apply(base, 8000);
  assert.equal(facts.rrspContribs.length, 2);
  assert.equal(facts.rrspContribs[0].source, 'override:deductions.rrspContrib');
  assert.equal(facts.rrspContribs[1].source, 'override:deductions.spousalRrspContrib');
  assert.equal(facts.rrspContribs[1].amount.toFixed(2), '8000.00');
});

test('apply: pensionSplit.transferAmount stamps synthetic pensionSplit field on facts', () => {
  const entry = getOverrideKey('pensionSplit.transferAmount')!;
  assert.equal(entry.kind, 'personal');
  entry.validate(15000);
  const facts = entry.apply(emptyFacts(), 15000);
  assert.ok(facts.pensionSplit, 'pensionSplit should be set');
  assert.equal(facts.pensionSplit!.transferAmount.toFixed(2), '15000.00');
});

test('apply: income.pensionIncome stamps facts.pensionIncome only (L11500 handles totalIncome)', () => {
  const entry = getOverrideKey('income.pensionIncome')!;
  assert.equal(entry.kind, 'personal');
  entry.validate(50000);
  // Seed with existing pension + employment to verify additive behavior.
  const base = emptyFacts();
  base.pensionIncome = D('1000');
  base.employmentIncome = [{ source: 'slip:T4', amount: D('80000'), cadAmount: D('80000') }];
  const facts = entry.apply(base, 50000);
  // facts.pensionIncome adds rather than replaces
  assert.equal(facts.pensionIncome!.toFixed(2), '51000.00');
  // employmentIncome[] is NOT touched — L11500 in t1.ts now handles pension in totalIncome
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].source, 'slip:T4');
});

test('apply: income.cppRetirement stamps facts.cppBenefits (not employment income)', () => {
  // CPP retirement benefits belong on L11400 — they are neither pensionable nor
  // insurable, so injecting them as employment income manufactured phantom CPP
  // contributions, EI premiums, and the Canada employment amount.
  const entry = getOverrideKey('income.cppRetirement')!;
  assert.equal(entry.kind, 'personal');
  entry.validate(16000);
  const base = emptyFacts();
  base.employmentIncome = [{ source: 'slip:T4', amount: D('80000'), cadAmount: D('80000') }];
  const facts = entry.apply(base, 16000);
  // pensionIncome left untouched (CPP is not eligible pension income)
  assert.equal(facts.pensionIncome, undefined);
  // employmentIncome[] NOT touched
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].source, 'slip:T4');
  // accumulates onto cppBenefits
  assert.equal(facts.cppBenefits!.toFixed(2), '16000.00');
  const again = entry.apply(facts, 1000);
  assert.equal(again.cppBenefits!.toFixed(2), '17000.00', 'repeated applies accumulate');
});

test('apply: income.oasRetirement stamps facts.oasBenefits (not employment income)', () => {
  const entry = getOverrideKey('income.oasRetirement')!;
  assert.equal(entry.kind, 'personal');
  entry.validate(8500);
  const base = emptyFacts();
  base.employmentIncome = [{ source: 'slip:T4', amount: D('80000'), cadAmount: D('80000') }];
  const facts = entry.apply(base, 8500);
  assert.equal(facts.pensionIncome, undefined);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].source, 'slip:T4');
  // oasBenefits feeds both L11300 and the L23500 clawback cap (OAS received)
  assert.equal(facts.oasBenefits!.toFixed(2), '8500.00');
  const again = entry.apply(facts, 500);
  assert.equal(again.oasBenefits!.toFixed(2), '9000.00', 'repeated applies accumulate');
});
