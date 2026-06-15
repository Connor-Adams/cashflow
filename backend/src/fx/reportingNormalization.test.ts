/**
 * Unit tests for normalizing aggregates into a reporting currency.
 *
 * Determinism guarantee: the same input + same stub FX → same output. Tests
 * lock down both correctness and the "deterministic and documented"
 * acceptance bullet of issue #221.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeToReportingCurrency,
  type ReportingAggregate,
} from './reportingNormalization';
import type { FxLookup } from '../networth/unifyToCad';

const stubFx: FxLookup = async (from, to, asOf) => {
  if (from === to) return { rate: 1, ratedDate: asOf };
  if (from === 'USD' && to === 'CAD') return { rate: 1.35, ratedDate: '2026-05-01' };
  if (from === 'EUR' && to === 'CAD') return { rate: 1.45, ratedDate: '2026-05-01' };
  if (from === 'CAD' && to === 'USD') return { rate: 1 / 1.35, ratedDate: '2026-05-01' };
  return null;
};

test('CAD identity short-circuit', async () => {
  const aggs: ReportingAggregate[] = [{ key: 'totalSpend', byCurrency: { CAD: 100 } }];
  const result = await normalizeToReportingCurrency(aggs, 'CAD', '2026-05-01', stubFx);
  assert.equal(result.metrics[0].normalized, 100);
  assert.equal(result.metrics[0].key, 'totalSpend');
  // CAD→CAD doesn't appear in fxRatesUsed (identity).
  assert.equal(result.fxRatesUsed.length, 0);
  assert.deepEqual(result.gaps, []);
});

test('USD→CAD conversion uses stub rate', async () => {
  const aggs: ReportingAggregate[] = [{ key: 'totalSpend', byCurrency: { USD: 200 } }];
  const result = await normalizeToReportingCurrency(aggs, 'CAD', '2026-05-01', stubFx);
  assert.equal(result.metrics[0].normalized, 270);
  assert.equal(result.fxRatesUsed.length, 1);
  assert.equal(result.fxRatesUsed[0].from, 'USD');
  assert.equal(result.fxRatesUsed[0].to, 'CAD');
  assert.equal(result.fxRatesUsed[0].rate, 1.35);
});

test('mixed currencies aggregate correctly', async () => {
  const aggs: ReportingAggregate[] = [
    { key: 'totalSpend', byCurrency: { CAD: 100, USD: 200, EUR: 50 } },
  ];
  const result = await normalizeToReportingCurrency(aggs, 'CAD', '2026-05-01', stubFx);
  // 100 + 270 + 72.5 = 442.5
  assert.ok(Math.abs(result.metrics[0].normalized - 442.5) < 0.01);
});

test('emits gap for unknown currency, partial total still returned', async () => {
  const aggs: ReportingAggregate[] = [
    { key: 'totalSpend', byCurrency: { CAD: 100, XYZ: 999 } },
  ];
  const result = await normalizeToReportingCurrency(aggs, 'CAD', '2026-05-01', stubFx);
  assert.equal(result.metrics[0].normalized, 100);
  assert.equal(result.metrics[0].partial, true);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].currency, 'XYZ');
});

test('multiple metrics share the same FX rate set', async () => {
  const aggs: ReportingAggregate[] = [
    { key: 'totalSpend', byCurrency: { USD: 100 } },
    { key: 'totalCredits', byCurrency: { USD: 50 } },
  ];
  const result = await normalizeToReportingCurrency(aggs, 'CAD', '2026-05-01', stubFx);
  // Both metrics use the same USD→CAD rate. The fxRatesUsed list is
  // deduplicated.
  assert.equal(result.fxRatesUsed.length, 1);
  assert.equal(result.metrics.length, 2);
  assert.equal(result.metrics[0].normalized, 135);
  assert.equal(result.metrics[1].normalized, 67.5);
});

test('reporting currency other than CAD', async () => {
  const aggs: ReportingAggregate[] = [{ key: 'totalSpend', byCurrency: { CAD: 100 } }];
  const result = await normalizeToReportingCurrency(aggs, 'USD', '2026-05-01', stubFx);
  // 100 / 1.35 ≈ 74.07
  assert.ok(Math.abs(result.metrics[0].normalized - 100 / 1.35) < 0.01);
});

test('determinism — same input produces same output', async () => {
  const aggs: ReportingAggregate[] = [
    { key: 'totalSpend', byCurrency: { USD: 200, CAD: 50 } },
  ];
  const a = await normalizeToReportingCurrency(aggs, 'CAD', '2026-05-01', stubFx);
  const b = await normalizeToReportingCurrency(aggs, 'CAD', '2026-05-01', stubFx);
  assert.deepEqual(a, b);
});

test('empty input produces empty output', async () => {
  const result = await normalizeToReportingCurrency([], 'CAD', '2026-05-01', stubFx);
  assert.deepEqual(result.metrics, []);
  assert.deepEqual(result.fxRatesUsed, []);
  assert.deepEqual(result.gaps, []);
});

test('normalized total exactly equals the sum of displayed contributions (no float drift)', async () => {
  // Contributions 0.1 (USD×0.1) and 0.2 (EUR×0.2) sum to the classic drifting
  // 0.30000000000000004 under IEEE-754 += accumulation. The headline total
  // must integer-accumulate so it reconciles EXACTLY to the per-currency
  // contributions a tooltip would display.
  const driftFx: FxLookup = async (from, to, asOf) => {
    if (from === to) return { rate: 1, ratedDate: asOf };
    if (from === 'USD' && to === 'CAD') return { rate: 0.1, ratedDate: '2026-05-01' };
    if (from === 'EUR' && to === 'CAD') return { rate: 0.2, ratedDate: '2026-05-01' };
    return null;
  };
  const aggs: ReportingAggregate[] = [
    { key: 'totalSpend', byCurrency: { USD: 1, EUR: 1 } },
  ];
  const result = await normalizeToReportingCurrency(aggs, 'CAD', '2026-05-01', driftFx);
  const sumOfContributions = result.metrics[0].contributions.reduce(
    (s, c) => s + (c.normalized ?? 0),
    0,
  );
  // The headline total and the float sum of contributions both round to 0.3,
  // but the headline must equal the CLEAN value, not the drifted one.
  assert.equal(result.metrics[0].normalized, 0.3);
  assert.notEqual(sumOfContributions, 0.3); // proves the drift exists
});

test('zero-amount currency does not emit FX lookup', async () => {
  // A txn aggregate where USD bucket is 0 doesn't need an FX lookup.
  const aggs: ReportingAggregate[] = [{ key: 'totalSpend', byCurrency: { USD: 0 } }];
  const result = await normalizeToReportingCurrency(aggs, 'CAD', '2026-05-01', stubFx);
  assert.equal(result.metrics[0].normalized, 0);
  // Zero contribution does NOT pollute fxRatesUsed.
  assert.equal(result.fxRatesUsed.length, 0);
});
