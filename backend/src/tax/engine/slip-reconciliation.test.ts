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
  carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0') },
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
