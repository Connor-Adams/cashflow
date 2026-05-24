/**
 * Unit tests for the pure adjusted cost base (ACB) engine in
 * src/portfolio/acb.ts. The engine is deterministic and stateless;
 * tests construct AcbActivity arrays directly without touching the DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeAcb, type AcbActivity } from '../../src/portfolio/acb';

let nextId = 1;
function act(
  tradeDate: string,
  activityType: string,
  quantity: number | null,
  amount: number | null,
  currency = 'CAD'
): AcbActivity {
  return {
    id: nextId++,
    tradeDate,
    activityType,
    quantity,
    amount,
    currency,
  };
}

const APPROX = (a: number, b: number, msg?: string, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, msg ?? `${a} ≉ ${b}`);

test('empty input returns zero state', () => {
  const r = computeAcb([]);
  assert.equal(r.finalState.quantity, 0);
  assert.equal(r.finalState.totalCost, 0);
  assert.equal(r.finalState.acbPerUnit, 0);
  assert.deepEqual(r.timeline, []);
  assert.deepEqual(r.realizedEvents, []);
  assert.equal(r.realizedTotal, 0);
});

test('single BUY produces the expected state', () => {
  const r = computeAcb([act('2024-01-15', 'buy', 10, 1000)]);
  assert.equal(r.finalState.quantity, 10);
  assert.equal(r.finalState.totalCost, 1000);
  assert.equal(r.finalState.acbPerUnit, 100);
  assert.equal(r.timeline.length, 1);
  assert.equal(r.realizedEvents.length, 0);
});

test('two BUYs produce weighted-average ACB', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000), // $100 per unit
    act('2024-02-15', 'buy', 5, 600), // $120 per unit
  ]);
  // Weighted average: (1000 + 600) / 15 = 106.6667
  assert.equal(r.finalState.quantity, 15);
  assert.equal(r.finalState.totalCost, 1600);
  APPROX(r.finalState.acbPerUnit, 1600 / 15);
  assert.equal(r.timeline.length, 2);
});

test('BUY then partial SELL — realized gain uses weighted-average ACB', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000), // 100/unit
    act('2024-02-15', 'buy', 10, 1400), // 140/unit → weighted avg 120
    act('2024-03-15', 'sell', 5, 700), // proceeds 700, cost 5*120 = 600 → gain 100
  ]);
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].acbPerUnitAtSale, 120);
  APPROX(r.realizedEvents[0].costRemoved, 600);
  APPROX(r.realizedEvents[0].realizedGain, 100);
  APPROX(r.realizedTotal, 100);
  // Remaining: 15 units at $120 cost preserved
  assert.equal(r.finalState.quantity, 15);
  APPROX(r.finalState.acbPerUnit, 120);
  APPROX(r.finalState.totalCost, 15 * 120);
});

test('BUY then full SELL — position closes and ACB resets', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-03-15', 'sell', 10, 1300),
  ]);
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].realizedGain, 300);
  assert.equal(r.finalState.quantity, 0);
  assert.equal(r.finalState.totalCost, 0);
  assert.equal(r.finalState.acbPerUnit, 0);
  // Should warn about position closing.
  assert.ok(r.warnings.some((w) => /Position closed/i.test(w)));
});

test('BUY → SELL all → BUY again starts ACB fresh from second BUY', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000), // 100/unit
    act('2024-03-15', 'sell', 10, 1200), // close, gain 200
    act('2024-06-15', 'buy', 5, 300), // fresh: 60/unit
  ]);
  APPROX(r.realizedTotal, 200);
  assert.equal(r.finalState.quantity, 5);
  APPROX(r.finalState.acbPerUnit, 60);
  APPROX(r.finalState.totalCost, 300);
  assert.equal(r.realizedEvents.length, 1);
});

test('SELL exceeding position emits a warning and clamps quantity', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 5, 500), // 100/unit, qty 5
    act('2024-03-15', 'sell', 10, 1000), // claims 10 units
  ]);
  assert.ok(r.warnings.some((w) => /exceeds position/i.test(w)));
  // Should clamp to 5 units sold; gain = 1000 - (5*100) = 500
  assert.equal(r.realizedEvents.length, 1);
  assert.equal(r.realizedEvents[0].qtySold, 5);
  APPROX(r.realizedEvents[0].realizedGain, 500);
  assert.equal(r.finalState.quantity, 0);
});

test('unsorted input is sorted by tradeDate then id before computing', () => {
  // Same activities, reversed order in input.
  const reversed: AcbActivity[] = [
    act('2024-03-15', 'sell', 5, 700),
    act('2024-02-15', 'buy', 10, 1400),
    act('2024-01-15', 'buy', 10, 1000),
  ];
  const r = computeAcb(reversed);
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].acbPerUnitAtSale, 120);
  APPROX(r.realizedEvents[0].realizedGain, 100);
  assert.equal(r.finalState.quantity, 15);
});

test('mixed-currency input emits a warning but does not throw', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000, 'CAD'),
    act('2024-02-15', 'buy', 5, 600, 'USD'),
  ]);
  assert.ok(r.warnings.some((w) => /Mixed currency/i.test(w)));
  assert.equal(r.currency, 'CAD');
});

test('dividends and interest are ignored — they do not move ACB or quantity', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-02-15', 'dividend', null, 25),
    act('2024-02-15', 'interest', null, 5),
    act('2024-02-15', 'fee', null, 2),
  ]);
  // Only the BUY shows up in timeline.
  assert.equal(r.timeline.length, 1);
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.acbPerUnit, 100);
  assert.equal(r.realizedEvents.length, 0);
});

test('SELL with missing quantity is ignored and warned', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-02-15', 'sell', null, 500),
  ]);
  assert.ok(r.warnings.some((w) => /missing quantity or amount/i.test(w)));
  // BUY still posted.
  assert.equal(r.finalState.quantity, 10);
  assert.equal(r.realizedEvents.length, 0);
});

test('amount sign is normalized: SELL proceeds use absolute value', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-02-15', 'sell', 5, -700), // negative amount, |.| = 700
  ]);
  APPROX(r.realizedEvents[0].proceeds, 700);
  APPROX(r.realizedEvents[0].realizedGain, 200);
});

test('multiple sells progressively reduce position at preserved ACB', () => {
  // BUY 100 @ 10 = 1000 cost (ACB 10)
  // BUY 100 @ 20 = 2000 cost (ACB 15)
  // SELL 50  @ 1000 → cost removed 50*15=750, gain 250, remaining 150 @ 15
  // SELL 100 @ 2200 → cost removed 100*15=1500, gain 700, remaining 50 @ 15
  // SELL 50  @ 1100 → cost removed 50*15=750, gain 350, remaining 0, ACB reset
  const r = computeAcb([
    act('2024-01-01', 'buy', 100, 1000),
    act('2024-02-01', 'buy', 100, 2000),
    act('2024-03-01', 'sell', 50, 1000),
    act('2024-04-01', 'sell', 100, 2200),
    act('2024-05-01', 'sell', 50, 1100),
  ]);
  assert.equal(r.realizedEvents.length, 3);
  APPROX(r.realizedEvents[0].realizedGain, 250);
  APPROX(r.realizedEvents[1].realizedGain, 700);
  APPROX(r.realizedEvents[2].realizedGain, 350);
  APPROX(r.realizedTotal, 1300);
  assert.equal(r.finalState.quantity, 0);
});

test('timeline records one entry per buy/sell, in chronological order', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-02-15', 'dividend', null, 25),
    act('2024-03-15', 'sell', 5, 600),
    act('2024-04-15', 'buy', 5, 700),
  ]);
  // Three buy/sell events → three timeline entries.
  assert.equal(r.timeline.length, 3);
  assert.equal(r.timeline[0].asOf, '2024-01-15');
  assert.equal(r.timeline[1].asOf, '2024-03-15');
  assert.equal(r.timeline[2].asOf, '2024-04-15');
});

// ---------------------------------------------------------------------------
// DRIP / reinvestment tests
// ---------------------------------------------------------------------------

test('DRIP after a BUY: per-unit ACB is correctly weighted', () => {
  // BUY 10 @ $1000 total → ACB $100/unit
  // DRIP 0.5 @ $52 total → new ACB = (1000+52)/10.5 ≈ 100.190476...
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-02-15', 'reinvestment', 0.5, 52),
  ]);
  assert.equal(r.finalState.quantity, 10.5);
  APPROX(r.finalState.totalCost, 1052);
  APPROX(r.finalState.acbPerUnit, 1052 / 10.5);
  // Both events must appear in the timeline.
  assert.equal(r.timeline.length, 2);
  assert.equal(r.realizedEvents.length, 0);
  assert.equal(r.warnings.length, 0);
});

test('DRIP with null quantity emits a warning and does not crash', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-02-15', 'reinvestment', null, 52),
  ]);
  assert.ok(r.warnings.some((w) => /missing quantity or amount/i.test(w)));
  // Position unchanged — only the BUY in the timeline.
  assert.equal(r.timeline.length, 1);
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.acbPerUnit, 100);
});

test('DRIP with null amount emits a warning and does not crash', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-02-15', 'reinvestment', 0.5, null),
  ]);
  assert.ok(r.warnings.some((w) => /missing quantity or amount/i.test(w)));
  // Position unchanged — only the BUY in the timeline.
  assert.equal(r.timeline.length, 1);
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.acbPerUnit, 100);
});

test('SELL after DRIPs uses the post-DRIP per-unit ACB', () => {
  // BUY 10 @ 1000 → ACB 100
  // DRIP 0.5 @ 52 → ACB (1052/10.5) ≈ 100.190476
  // SELL 5 shares → proceeds 520, cost removed 5 * (1052/10.5), gain = 520 - cost
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-02-15', 'reinvestment', 0.5, 52),
    act('2024-03-15', 'sell', 5, 520),
  ]);
  const expectedAcb = 1052 / 10.5;
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].acbPerUnitAtSale, expectedAcb);
  APPROX(r.realizedEvents[0].costRemoved, 5 * expectedAcb);
  APPROX(r.realizedEvents[0].realizedGain, 520 - 5 * expectedAcb);
  // Remaining: 5.5 shares at same per-unit ACB.
  APPROX(r.finalState.quantity, 5.5);
  APPROX(r.finalState.acbPerUnit, expectedAcb);
});

test('DRIP into a closed position (qty 0) starts a fresh ACB', () => {
  // BUY 10 @ 1000, SELL 10 (close), then DRIP 0.5 @ 52.
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-02-15', 'sell', 10, 1200), // close; ACB reset
    act('2024-03-15', 'reinvestment', 0.5, 52), // fresh position
  ]);
  assert.equal(r.finalState.quantity, 0.5);
  APPROX(r.finalState.totalCost, 52);
  APPROX(r.finalState.acbPerUnit, 104);
  // Realized from the SELL only.
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].realizedGain, 200);
});
