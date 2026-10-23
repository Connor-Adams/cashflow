import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { sbdEligibleIncome, ontarioSbdRate } from './sbd';
import { ratesFor } from './brackets';

const r = ratesFor(2024);

test('SBD: ABI $300k, no AAII — all income eligible for SBD', () => {
  const result = sbdEligibleIncome(D('300000'), D('0'), r);
  assert.equal(result.limit.toFixed(2), '500000.00');
  assert.equal(result.eligible.toFixed(2), '300000.00');
  assert.equal(result.generalRate.toFixed(2), '0.00');
});

test('SBD: ABI $600k, no AAII — $500k SBD + $100k general', () => {
  const result = sbdEligibleIncome(D('600000'), D('0'), r);
  assert.equal(result.limit.toFixed(2), '500000.00');
  assert.equal(result.eligible.toFixed(2), '500000.00');
  assert.equal(result.generalRate.toFixed(2), '100000.00');
});

test('SBD: AAII $50k — exactly at threshold, no grind', () => {
  const result = sbdEligibleIncome(D('500000'), D('50000'), r);
  // grind = max(0, 50000 - 50000) × 5 = 0; limit = 500000
  assert.equal(result.limit.toFixed(2), '500000.00');
  assert.equal(result.eligible.toFixed(2), '500000.00');
  assert.equal(result.generalRate.toFixed(2), '0.00');
});

test('SBD: AAII $100k — $250k grind', () => {
  const result = sbdEligibleIncome(D('500000'), D('100000'), r);
  // grind = (100000 - 50000) × 5 = 250000; limit = 500000 - 250000 = 250000
  assert.equal(result.limit.toFixed(2), '250000.00');
  assert.equal(result.eligible.toFixed(2), '250000.00');
  assert.equal(result.generalRate.toFixed(2), '250000.00');
});

test('SBD: AAII $150k — full grind (limit $0)', () => {
  const result = sbdEligibleIncome(D('400000'), D('150000'), r);
  // grind = (150000 - 50000) × 5 = 500000; limit = max(0, 500000 - 500000) = 0
  assert.equal(result.limit.toFixed(2), '0.00');
  assert.equal(result.eligible.toFixed(2), '0.00');
  assert.equal(result.generalRate.toFixed(2), '400000.00');
});

test('SBD: AAII > $150k — limit clamped at 0, not negative', () => {
  const result = sbdEligibleIncome(D('200000'), D('200000'), r);
  // grind = (200000 - 50000) × 5 = 750000 > 500000; limit = 0
  assert.equal(result.limit.toFixed(2), '0.00');
  assert.equal(result.eligible.toFixed(2), '0.00');
  assert.equal(result.generalRate.toFixed(2), '200000.00');
});

test('SBD: ABI $400k, AAII $80k — scenario C from spec', () => {
  const result = sbdEligibleIncome(D('400000'), D('80000'), r);
  // grind = (80000 - 50000) × 5 = 150000; limit = 500000 - 150000 = 350000
  // eligible = min(400000, 350000) = 350000; general = 50000
  assert.equal(result.limit.toFixed(2), '350000.00');
  assert.equal(result.eligible.toFixed(2), '350000.00');
  assert.equal(result.generalRate.toFixed(2), '50000.00');
});

test('SBD: zero ABI', () => {
  const result = sbdEligibleIncome(D('0'), D('0'), r);
  assert.equal(result.eligible.toFixed(2), '0.00');
  assert.equal(result.generalRate.toFixed(2), '0.00');
});

// Taxation Act, 2007 (Ontario) s.31(4)(e)-(f), as amended by S.O. 2026, c. 2,
// Sch. 15: the Ontario small business rate is 3.2% for days before 2026-07-01
// and 2.2% for days after 2026-06-30, weighted by days in the taxation year.
test('ON SBD rate: fiscal year ending before 2026-07-01 pays 3.2%', () => {
  const rate = ontarioSbdRate({ startDate: '2025-07-01', endDate: '2026-06-30' }, ratesFor(2025));
  assert.equal(rate.toString(), '0.032');
});

test('ON SBD rate: Dec-31 2026 year end blends 181 days at 3.2% and 184 at 2.2%', () => {
  const rate = ontarioSbdRate({ startDate: '2026-01-01', endDate: '2026-12-31' }, ratesFor(2026));
  // (181 × 3.2% + 184 × 2.2%) / 365
  assert.equal(rate.toFixed(6), '0.026959');
});

test('ON SBD rate: fiscal year starting 2026-07-01 pays 2.2% throughout', () => {
  const rate = ontarioSbdRate({ startDate: '2026-07-01', endDate: '2027-06-30' }, ratesFor(2026));
  assert.equal(rate.toString(), '0.022');
});

test('ON SBD rate: a year starting in 2025 that ends after 2026-06-30 is prorated too', () => {
  // 2025-08-01..2026-07-31: 365 days, 31 of them after 2026-06-30.
  const rate = ontarioSbdRate({ startDate: '2025-08-01', endDate: '2026-07-31' }, ratesFor(2025));
  assert.equal(rate.toFixed(6), D('0.032').times(334).plus(D('0.022').times(31)).dividedBy(365).toFixed(6));
});

test('ON SBD rate: 2027 years pay 2.2% with no change pending', () => {
  const t = ratesFor(2027);
  assert.equal(t.corpAbiSbdRateOntarioChange, undefined);
  assert.equal(ontarioSbdRate({ startDate: '2027-01-01', endDate: '2027-12-31' }, t).toString(), '0.022');
});

test('ON SBD rate: 2024 years pay 3.2% with no change', () => {
  assert.equal(ontarioSbdRate({ startDate: '2024-01-01', endDate: '2024-12-31' }, ratesFor(2024)).toString(), '0.032');
});
