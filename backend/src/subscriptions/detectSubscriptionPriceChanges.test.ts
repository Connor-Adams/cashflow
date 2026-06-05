// backend/test/detectSubscriptionPriceChanges.test.ts
//
// Pure-function unit test of the subscription price-change decision math.
//
// The full DB-level detector (`detectSubscriptionPriceChanges`) queries
// `Transaction.merchantClean` with `Op.iLike`, which Sequelize emits as raw
// `ILIKE` — a syntax SQLite does not support (`SQLITE_ERROR: near "ILIKE"`).
// So the end-to-end "emits an Insight" assertions live in the Postgres
// integration suite (`test/integration/detectSubscriptionPriceChanges.test.ts`,
// CI-only). Here we test the dialect-independent threshold/median logic
// extracted into the pure `evaluatePriceChange` helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePriceChange } from './detectSubscriptionPriceChanges';

test('evaluatePriceChange: detects a >=5% increase vs the 90d median', () => {
  // Expenses are stored as negative decimal strings; magnitude is what grows.
  const e = evaluatePriceChange('-11.00', ['-10.00', '-10.00']);
  assert.ok(e);
  assert.equal(e!.latestCents, 1100);
  assert.equal(e!.baselineCents, 1000);
  assert.equal(Number(e!.delta.toFixed(3)), 0.1); // +10%
});

test('evaluatePriceChange: returns null on a price DROP', () => {
  const e = evaluatePriceChange('-8.00', ['-10.00', '-10.00']); // -20%
  assert.equal(e, null);
});

test('evaluatePriceChange: returns null on a sub-5% increase', () => {
  const e = evaluatePriceChange('-10.40', ['-10.00', '-10.00']); // +4%
  assert.equal(e, null);
});

test('evaluatePriceChange: detects exactly +5% (threshold is inclusive)', () => {
  const e = evaluatePriceChange('-10.50', ['-10.00', '-10.00']); // +5%
  assert.ok(e);
  assert.equal(e!.latestCents, 1050);
  assert.equal(e!.baselineCents, 1000);
});

test('evaluatePriceChange: uses the MEDIAN of priors as the baseline', () => {
  // Median of [10, 10, 20] = 10; latest 11 => +10% (mean would be ~13.3 => drop).
  const e = evaluatePriceChange('-11.00', ['-10.00', '-10.00', '-20.00']);
  assert.ok(e);
  assert.equal(e!.baselineCents, 1000);
  assert.equal(e!.latestCents, 1100);
});

test('evaluatePriceChange: returns null with no prior charges', () => {
  assert.equal(evaluatePriceChange('-11.00', []), null);
});

test('evaluatePriceChange: returns null when the baseline median is zero', () => {
  assert.equal(evaluatePriceChange('-11.00', ['0', '0']), null);
});
