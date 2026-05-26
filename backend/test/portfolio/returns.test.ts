import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTwr, type DailyPoint } from '../../src/portfolio/returns';
import { computeXirr, type IrrCashFlow } from '../../src/portfolio/returns';

function approxEqual(actual: number, expected: number, eps = 1e-2): void {
  assert.ok(Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`);
}

test('computeTwr — empty array returns 0', () => {
  assert.equal(computeTwr([]), 0);
});

test('computeTwr — single point returns 0', () => {
  const p: DailyPoint = { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 };
  assert.equal(computeTwr([p]), 0);
});

test('computeTwr — zero starting MV returns 0', () => {
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 0, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 100, cashFlowCad: 100 },
  ];
  assert.equal(computeTwr(points), 0);
});

test('computeTwr — value doubles, no cash flow → 100%', () => {
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 2000, cashFlowCad: 0 },
  ];
  approxEqual(computeTwr(points), 100);
});

test('computeTwr — value unchanged → 0%', () => {
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 1000, cashFlowCad: 0 },
  ];
  approxEqual(computeTwr(points), 0);
});

test('computeTwr — deposit mid-period removed from return', () => {
  // Day 1: $1000. Day 2: deposit $500, end MV $1500. No actual investment return.
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 1500, cashFlowCad: 500 },
  ];
  approxEqual(computeTwr(points), 0);
});

test('computeTwr — multi-period chain', () => {
  // Day 1: $1000. Day 2: $1100 (+10%, no flow). Day 3: $2000 (deposit $800, real growth = ($2000 - $800) / $1100 - 1 = +9.09%).
  // TWR = (1.10)(1.0909) - 1 = 0.2 → 20%
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 1100, cashFlowCad: 0 },
    { date: '2026-01-03', marketValueCad: 2000, cashFlowCad: 800 },
  ];
  approxEqual(computeTwr(points), 20, 0.1);
});

test('computeXirr — single deposit + 1Y final value of 1.10x → ~10%', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 1100 },
  ];
  const r = computeXirr(cf);
  assert.ok(r !== null);
  approxEqual(r as number, 10, 0.5);
});

test('computeXirr — single deposit + same-year doubling → ~100%', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 2000 },
  ];
  const r = computeXirr(cf);
  assert.ok(r !== null);
  approxEqual(r as number, 100, 1);
});

test('computeXirr — multi-deposit DCA pattern returns finite number', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2025-07-01', amount: -1000 },
    { date: '2026-01-01', amount: 2300 },
  ];
  const r = computeXirr(cf);
  assert.ok(r !== null);
  assert.ok(Number.isFinite(r as number));
});

test('computeXirr — no cash flows returns null', () => {
  assert.equal(computeXirr([]), null);
});

test('computeXirr — only positive flows (no investment) returns null', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: 100 },
    { date: '2026-01-01', amount: 200 },
  ];
  assert.equal(computeXirr(cf), null);
});

test('computeXirr — negative return', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 500 },
  ];
  const r = computeXirr(cf);
  assert.ok(r !== null);
  assert.ok((r as number) < 0);
});

import { buildCashFlowSeries, type AggregatedDailySnapshot } from '../../src/portfolio/returns';

test('buildCashFlowSeries — minimal: 1 day initial + final', () => {
  const snaps: AggregatedDailySnapshot[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-12-31', marketValueCad: 1100, cashFlowCad: 0 },
  ];
  const cf = buildCashFlowSeries(snaps, 1100);
  assert.equal(cf.length, 2);
  assert.equal(cf[0].amount, -1000);
  assert.equal(cf[0].date, '2026-01-01');
  assert.equal(cf[1].amount, 1100);
  assert.equal(cf[1].date, '2026-12-31');
});

test('buildCashFlowSeries — includes mid-stream deposits/withdrawals', () => {
  const snaps: AggregatedDailySnapshot[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-06-15', marketValueCad: 1500, cashFlowCad: 400 },
    { date: '2026-12-31', marketValueCad: 1700, cashFlowCad: 0 },
  ];
  const cf = buildCashFlowSeries(snaps, 1700);
  assert.equal(cf.length, 3);
  assert.equal(cf[0].amount, -1000);
  assert.equal(cf[1].amount, -400);
  assert.equal(cf[1].date, '2026-06-15');
  assert.equal(cf[2].amount, 1700);
});

test('buildCashFlowSeries — empty snapshots returns empty array', () => {
  assert.deepEqual(buildCashFlowSeries([], 0), []);
});

import { computeBenchmarkSeries } from '../../src/portfolio/returns';

test('computeBenchmarkSeries — flat prices → flat at initial value', () => {
  const prices = [
    { date: '2026-01-01', adjClose: 100 },
    { date: '2026-01-02', adjClose: 100 },
    { date: '2026-01-03', adjClose: 100 },
  ];
  const fx = new Map([
    ['2026-01-01', 1.0],
    ['2026-01-02', 1.0],
    ['2026-01-03', 1.0],
  ]);
  const series = computeBenchmarkSeries(prices, fx, 10000);
  assert.equal(series.length, 3);
  series.forEach((s) => approxEqual(s.valueCad, 10000));
});

test('computeBenchmarkSeries — doubling price doubles series', () => {
  const prices = [
    { date: '2026-01-01', adjClose: 100 },
    { date: '2026-01-02', adjClose: 200 },
  ];
  const fx = new Map([
    ['2026-01-01', 1.0],
    ['2026-01-02', 1.0],
  ]);
  const series = computeBenchmarkSeries(prices, fx, 1000);
  approxEqual(series[0].valueCad, 1000);
  approxEqual(series[1].valueCad, 2000);
});

test('computeBenchmarkSeries — FX change reflected', () => {
  // Buy 10 USD shares at $100 each = $1000 USD = $1370 CAD at fx 1.37
  // Day 2: same USD price, FX moves to 1.40 → $1400 CAD
  const prices = [
    { date: '2026-01-01', adjClose: 100 },
    { date: '2026-01-02', adjClose: 100 },
  ];
  const fx = new Map([
    ['2026-01-01', 1.37],
    ['2026-01-02', 1.40],
  ]);
  const series = computeBenchmarkSeries(prices, fx, 1370);
  approxEqual(series[0].valueCad, 1370);
  approxEqual(series[1].valueCad, 1400);
});

test('computeBenchmarkSeries — missing FX forward-fills', () => {
  const prices = [
    { date: '2026-01-01', adjClose: 100 },
    { date: '2026-01-02', adjClose: 100 },
    { date: '2026-01-03', adjClose: 100 },
  ];
  const fx = new Map([
    ['2026-01-01', 1.37],
    ['2026-01-03', 1.40],
  ]);
  const series = computeBenchmarkSeries(prices, fx, 1370);
  approxEqual(series[1].valueCad, 1370); // forward-fill from 2026-01-01
});

test('computeBenchmarkSeries — empty prices returns empty array', () => {
  assert.deepEqual(computeBenchmarkSeries([], new Map(), 1000), []);
});
