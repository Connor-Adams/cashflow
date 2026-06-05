import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { sbdEligibleIncome } from './sbd';
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
