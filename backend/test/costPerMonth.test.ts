/**
 * Pure unit tests for the cost-per-month-owned calculator that drives
 * purchase intelligence (issue #218).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  costPerMonth,
  elapsedMonths,
} from '../src/util/costPerMonth.js';

test('elapsedMonths returns 0 for asOf equal to purchase date', () => {
  assert.equal(elapsedMonths('2026-05-01', '2026-05-01'), 0);
});

test('elapsedMonths returns 0 when asOf is before purchase date', () => {
  assert.equal(elapsedMonths('2026-05-01', '2026-04-01'), 0);
});

test('elapsedMonths is ~1 for ~30-day delta', () => {
  // 30 days / 30.4375 ≈ 0.9856
  const v = elapsedMonths('2026-05-01', '2026-05-31');
  assert.ok(v > 0.95 && v < 1.0, `expected ~0.985, got ${v}`);
});

test('elapsedMonths is ~12 for a one-year delta', () => {
  const v = elapsedMonths('2025-05-01', '2026-05-01');
  // 365 days / 30.4375 ≈ 11.9918
  assert.ok(v > 11.9 && v < 12.1, `expected ~12, got ${v}`);
});

test('costPerMonth: brand-new purchase floors elapsed at 1 month', () => {
  const r = costPerMonth({
    amountAbs: 600,
    purchaseDate: '2026-05-26',
    asOf: '2026-05-26',
  });
  // 600 / 1 = 600
  assert.equal(r.costPerMonth, 600);
  assert.equal(r.monthsOwned, 1);
  assert.equal(r.denominatorMonths, 1);
});

test('costPerMonth: 12 months owned with no declared life gives amount/12', () => {
  const r = costPerMonth({
    amountAbs: 1200,
    purchaseDate: '2025-05-01',
    asOf: '2026-05-01',
  });
  // 1200 / ~11.99 ≈ 100.08
  assert.ok(
    r.costPerMonth > 99 && r.costPerMonth < 101,
    `expected ~100, got ${r.costPerMonth}`,
  );
});

test('costPerMonth: declared useful life caps denominator while asset is young', () => {
  const r = costPerMonth({
    amountAbs: 2400,
    purchaseDate: '2026-04-01',
    asOf: '2026-05-01',
    usefulLifeMonths: 60,
  });
  // ~1 month elapsed, declared life 60 → denom = 60
  // 2400 / 60 = 40
  assert.equal(r.costPerMonth, 40);
  assert.equal(r.denominatorMonths, 60);
});

test('costPerMonth: past useful life keeps elapsed as denominator', () => {
  const r = costPerMonth({
    amountAbs: 2400,
    purchaseDate: '2018-05-01',
    asOf: '2026-05-01',
    usefulLifeMonths: 60,
  });
  // 8 years ≈ 95.9 months, useful life 60 → use elapsed (95.9)
  // 2400 / ~95.9 ≈ 25.03
  assert.ok(
    r.costPerMonth > 24 && r.costPerMonth < 27,
    `expected ~25, got ${r.costPerMonth}`,
  );
  assert.ok(r.denominatorMonths > 60, 'denominator should exceed declared life when elapsed beats it');
});

test('costPerMonth: zero amount returns zero, denom stays 1', () => {
  const r = costPerMonth({
    amountAbs: 0,
    purchaseDate: '2026-05-01',
    asOf: '2026-05-26',
  });
  assert.equal(r.costPerMonth, 0);
});

test('costPerMonth: rounds to two decimal places', () => {
  const r = costPerMonth({
    amountAbs: 100,
    purchaseDate: '2026-04-01',
    asOf: '2026-05-01',
  });
  // 100 / ~0.986 elapsed (floored to 1) = 100 → exact
  assert.equal(r.costPerMonth, 100);
  // But test a non-round case
  const r2 = costPerMonth({
    amountAbs: 333.33,
    purchaseDate: '2026-04-01',
    asOf: '2026-05-01',
    usefulLifeMonths: 7,
  });
  // 333.33 / 7 ≈ 47.6186 → 47.62
  assert.equal(r2.costPerMonth, 47.62);
});

test('costPerMonth: usefulLifeMonths = null is the same as undefined', () => {
  const withNull = costPerMonth({
    amountAbs: 1000,
    purchaseDate: '2025-11-01',
    asOf: '2026-05-01',
    usefulLifeMonths: null,
  });
  const withUndef = costPerMonth({
    amountAbs: 1000,
    purchaseDate: '2025-11-01',
    asOf: '2026-05-01',
  });
  assert.equal(withNull.costPerMonth, withUndef.costPerMonth);
});

test('costPerMonth: invalid useful life (0 or negative) falls back to elapsed', () => {
  const r = costPerMonth({
    amountAbs: 600,
    purchaseDate: '2025-11-01',
    asOf: '2026-05-01',
    usefulLifeMonths: 0,
  });
  // 0 is invalid → fall back to elapsed (~6 months)
  // 600 / ~5.97 ≈ 100.5
  assert.ok(
    r.costPerMonth > 99 && r.costPerMonth < 102,
    `expected ~100.5, got ${r.costPerMonth}`,
  );
});
