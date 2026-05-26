import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTwr, type DailyPoint } from '../../src/portfolio/returns';

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
