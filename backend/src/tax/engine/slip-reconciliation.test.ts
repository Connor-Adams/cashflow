import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal.js';
import { ratesFor } from './brackets.js';
import { buildT1 } from './t1.js';
import type { TaxYearFacts } from './types.js';

const baseFacts = (): TaxYearFacts => ({
  year: 2025,
  jurisdiction: 'CA-ON',
  employmentIncome: [],
  selfEmploymentIncome: [],
  selfEmploymentExpenses: [],
  interestIncome: [{ source: 'computed', amount: D('1000'), cadAmount: D('1000') }],
  eligibleDividends: [{ source: 'computed', amount: D('2000'), cadAmount: D('2000') }],
  nonEligibleDividends: [{ source: 'computed', amount: D('500'), cadAmount: D('500') }],
  capitalGainEvents: [],
  rrspContribs: [],
  fhsaContribs: [],
  donations: [],
  slips: [],
  rentalIncome: [],
  rentalExpenses: [],
  medicalExpenses: [],
  carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0'), fhsaRoom: D('0') },
  ageAtYearEnd: 40,
});

test('T5 slip interest (box 13) preferred over computed interest', () => {
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.slips = [{
    slipId: 10,
    slipType: 'T5',
    issuer: 'Bank',
    boxes: { box13: D('1200') },
  }];
  const ret = buildT1(facts, r);
  const l12100 = ret.lines.find(l => l.code === 'L12100');
  assert.ok(l12100);
  assert.equal(l12100!.amount.toFixed(2), '1200.00');
});

test('T5 slip eligible dividends (box 25) preferred over computed', () => {
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.slips = [{
    slipId: 10,
    slipType: 'T5',
    issuer: 'Broker',
    boxes: { box25: D('2500') },
  }];
  const ret = buildT1(facts, r);
  assert.ok(ret.warnings.some(w => w.includes('T5') && w.includes('eligible')));
});

test('warns when T5 diverges from computed by >$50', () => {
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.slips = [{
    slipId: 10,
    slipType: 'T5',
    issuer: 'Bank',
    boxes: { box13: D('2000') },
  }];
  const ret = buildT1(facts, r);
  assert.ok(ret.warnings.some(w => w.includes('T5') && w.includes('interest') && w.includes('1000')));
});

// ---------------------------------------------------------------------------
// CRA box meanings (part 2). Two boxes were mapped to the wrong field:
//
//   T5 box 26 is the DIVIDEND TAX CREDIT for eligible dividends, not the taxable
//   amount of non-eligible dividends. That is box 11.
//   T3 box 49 is the ACTUAL amount of eligible dividends. The taxable amount is
//   box 50.
//
// Both failure modes are silent in different ways, so both are locked here.
// ---------------------------------------------------------------------------

test('T5 box 11 is the taxable non-eligible dividend amount, and it reconciles', () => {
  // What CDG Labs will actually issue: boxes 10/11/12, box 26 empty. Before the
  // fix box 11 was never read, so the slip was decorative — it reconciled against
  // nothing and raised no warning, which is the one cross-check wanted at filing.
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.nonEligibleDividends = [{ source: 'computed', amount: D('67000'), cadAmount: D('67000') }];
  facts.slips = [{
    slipId: 20,
    slipType: 'T5',
    issuer: 'CDG LABS INC.',
    // Deliberately a few cents off the naive gross-up, so this can only pass if
    // box 11 is actually read — 67,000 × 1.15 is 77,050.00 exactly, and a test
    // that asserted that would pass whether or not the box was consulted.
    boxes: { box10: D('67000'), box11: D('77050.37'), box12: D('6957.69') },
  }];
  const ret = buildT1(facts, r);
  const l12010 = ret.lines.find((l) => l.code === 'L12010');
  assert.ok(l12010);
  assert.equal(l12010.amount.toFixed(2), '77050.37', 'box 11 is the taxable amount');
  assert.equal(
    ret.warnings.filter((w) => /non-eligible/i.test(w)).length,
    0,
    'a slip that agrees with the computation must not warn',
  );
});

test('T5 box 11 disagreeing with the computation warns', () => {
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.nonEligibleDividends = [{ source: 'computed', amount: D('67000'), cadAmount: D('67000') }];
  facts.slips = [{
    slipId: 21,
    slipType: 'T5',
    issuer: 'CDG LABS INC.',
    boxes: { box11: D('50000') },
  }];
  const ret = buildT1(facts, r);
  assert.ok(
    ret.warnings.some((w) => /non-eligible/i.test(w)),
    `expected a divergence warning, got ${JSON.stringify(ret.warnings)}`,
  );
});

test('T5 box 26 does not disturb the non-eligible dividend line', () => {
  // box 26 is the eligible DTC. Reading it as taxable non-eligible dividends both
  // added a ~15% credit figure as income AND suppressed the real computed
  // dividends, which for this taxpayer is tens of thousands of dollars.
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.nonEligibleDividends = [{ source: 'computed', amount: D('67000'), cadAmount: D('67000') }];
  facts.eligibleDividends = [{ source: 'computed', amount: D('1000'), cadAmount: D('1000') }];
  facts.slips = [{
    slipId: 22,
    slipType: 'T5',
    issuer: 'Broker',
    boxes: { box24: D('1000'), box25: D('1380'), box26: D('207.27') },
  }];
  const ret = buildT1(facts, r);
  const l12010 = ret.lines.find((l) => l.code === 'L12010');
  assert.ok(l12010);
  // The computed gross-up stands: 67,000 × 1.15.
  assert.equal(l12010.amount.toFixed(2), '77050.00');
  // And the eligible line takes box 25, which was always correct.
  const l12000 = ret.lines.find((l) => l.code === 'L12000');
  assert.equal(l12000?.amount.toFixed(2), '1380.00');
});

test('T3 box 50 is the taxable eligible dividend amount, not box 49', () => {
  // box 49 is the ACTUAL amount; taking it as taxable understated eligible
  // dividends by the whole 38% gross-up.
  const r = ratesFor(2025);
  const facts = baseFacts();
  facts.eligibleDividends = [{ source: 'computed', amount: D('1000'), cadAmount: D('1000') }];
  facts.slips = [{
    slipId: 23,
    slipType: 'T3',
    issuer: 'Trust',
    boxes: { box49: D('1000'), box50: D('1380') },
  }];
  const ret = buildT1(facts, r);
  const l12000 = ret.lines.find((l) => l.code === 'L12000');
  assert.equal(l12000?.amount.toFixed(2), '1380.00');
});

// FHSA deduction is bounded by stored participation room, not by the annual limit.
// A contributor who skipped a year has two years available; capping at the annual
// limit lost the carried year. `fhsa_room` was computed and persisted by the roll
// and never read.
test('FHSA deduction uses stored room, so a catch-up year deducts both years', () => {
  const r = ratesFor(2026);
  const facts = baseFacts();
  facts.year = 2026;
  facts.fhsaContribs = [{ source: 'WS FHSA', amount: D('16000'), date: '2026-03-01' }];
  facts.carryforwards = { ...facts.carryforwards, fhsaRoom: D('16000') };
  const ret = buildT1(facts, r);
  const l20805 = ret.lines.find((l) => l.code === 'L20805');
  assert.equal(l20805?.amount.toFixed(2), '16000.00');
});

test('FHSA deduction is still bounded — a contribution past the room is capped', () => {
  const r = ratesFor(2026);
  const facts = baseFacts();
  facts.year = 2026;
  facts.fhsaContribs = [{ source: 'WS FHSA', amount: D('16000'), date: '2026-03-01' }];
  facts.carryforwards = { ...facts.carryforwards, fhsaRoom: D('4000') };
  const ret = buildT1(facts, r);
  const l20805 = ret.lines.find((l) => l.code === 'L20805');
  assert.equal(l20805?.amount.toFixed(2), '4000.00');
});
