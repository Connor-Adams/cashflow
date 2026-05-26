import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rrifMinPercent, rrifMinWithdrawal } from '../../src/tax/engine/rrif';

test('rrifMinPercent: age 70 → 0 (below mandatory RRIF age)', () => {
  assert.equal(rrifMinPercent(70), 0);
});

test('rrifMinPercent: age 71 → 0.0528 (first prescribed entry)', () => {
  assert.equal(rrifMinPercent(71), 0.0528);
});

test('rrifMinPercent: age 80 → 0.0682', () => {
  assert.equal(rrifMinPercent(80), 0.0682);
});

test('rrifMinPercent: age 94 → 0.1879 (last entry before 95+ flat)', () => {
  assert.equal(rrifMinPercent(94), 0.1879);
});

test('rrifMinPercent: age 100 → 0.20 (95+ flat rate)', () => {
  assert.equal(rrifMinPercent(100), 0.2);
});

test('rrifMinWithdrawal: age 80 × $500,000 = $34,100', () => {
  // 500_000 × 0.0682 = 34_100
  assert.equal(rrifMinWithdrawal(80, 500_000), 34_100);
});

test('rrifMinWithdrawal: age 70 returns 0 regardless of balance', () => {
  assert.equal(rrifMinWithdrawal(70, 1_000_000), 0);
});
