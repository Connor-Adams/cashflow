/**
 * Unit tests for the pure adjusted cost base (ACB) engine in
 * src/portfolio/acb.ts. The engine is deterministic and stateless;
 * tests construct AcbActivity arrays directly without touching the DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeAcb, type AcbActivity } from './acb';

let nextId = 1;
function act(
  tradeDate: string,
  activityType: string,
  quantity: number | null,
  amount: number | null,
  currency = 'CAD',
  fees: number | null = null
): AcbActivity {
  return {
    id: nextId++,
    tradeDate,
    activityType,
    quantity,
    amount,
    currency,
    fees,
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

// ---------------------------------------------------------------------------
// Fee / commission handling (CRA rules)
// ---------------------------------------------------------------------------

test('BUY with fees: fees are added to total cost and affect per-unit ACB', () => {
  // 10 units, $1000 trade amount, $9.99 commission → total cost $1009.99
  const r = computeAcb([act('2024-01-15', 'buy', 10, 1000, 'CAD', 9.99)]);
  APPROX(r.finalState.totalCost, 1009.99);
  APPROX(r.finalState.acbPerUnit, 1009.99 / 10);
  assert.equal(r.finalState.quantity, 10);
});

test('SELL with fees: fees reduce net proceeds and therefore realized gain', () => {
  // BUY 10 @ $100 each = $1000 total cost, no fees → ACB $100/unit
  // SELL 10 @ $1300 gross, $9.99 commission → net proceeds $1290.01
  // Realized gain = $1290.01 - $1000 = $290.01
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000, 'CAD', null),
    act('2024-03-15', 'sell', 10, 1300, 'CAD', 9.99),
  ]);
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].proceeds, 1290.01);
  APPROX(r.realizedEvents[0].costRemoved, 1000);
  APPROX(r.realizedEvents[0].realizedGain, 290.01);
  APPROX(r.realizedTotal, 290.01);
});

test('SELL with fees: costRemoved is unchanged by SELL fee (only ACB at sale time matters)', () => {
  // BUY 20 @ $50 each ($1000 total, no fee) → ACB $50/unit
  // SELL 10 @ $700 gross, $5 fee → net proceeds $695, cost removed 10*50=$500, gain $195
  // Remaining 10 units still at ACB $50 each
  const r = computeAcb([
    act('2024-01-15', 'buy', 20, 1000, 'CAD', null),
    act('2024-03-15', 'sell', 10, 700, 'CAD', 5),
  ]);
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].proceeds, 695);
  APPROX(r.realizedEvents[0].costRemoved, 500);
  APPROX(r.realizedEvents[0].realizedGain, 195);
  assert.equal(r.finalState.quantity, 10);
  // Remaining position ACB per unit must not be contaminated by the sell fee
  APPROX(r.finalState.acbPerUnit, 50);
  APPROX(r.finalState.totalCost, 500);
});

test('multiple BUYs with varying fees: weighted-average ACB includes all fees', () => {
  // BUY 10 @ $100 + $10 fee = $1010 cost
  // BUY  5 @ $120/unit = $600 + $5 fee = $605 cost
  // Total cost = $1615 for 15 units → ACB $1615/15 ≈ $107.6667/unit
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000, 'CAD', 10),
    act('2024-02-15', 'buy', 5, 600, 'CAD', 5),
  ]);
  assert.equal(r.finalState.quantity, 15);
  APPROX(r.finalState.totalCost, 1615);
  APPROX(r.finalState.acbPerUnit, 1615 / 15);
});

test('fees: null and fees: 0 are both treated as zero (no effect)', () => {
  const rNull = computeAcb([act('2024-01-15', 'buy', 10, 1000, 'CAD', null)]);
  const rZero = computeAcb([act('2024-01-15', 'buy', 10, 1000, 'CAD', 0)]);
  APPROX(rNull.finalState.totalCost, 1000);
  APPROX(rZero.finalState.totalCost, 1000);
  APPROX(rNull.finalState.acbPerUnit, 100);
  APPROX(rZero.finalState.acbPerUnit, 100);
});

test('fees are ignored on no-op activity types (dividend, fee-type, etc.)', () => {
  // A "fee" activity type is a no-op in ACB; any fees field on it should not
  // move the ACB or quantity.
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000, 'CAD', 9),
    act('2024-02-15', 'fee', null, 25, 'CAD', 2),
  ]);
  // Only one timeline entry (the BUY)
  assert.equal(r.timeline.length, 1);
  APPROX(r.finalState.totalCost, 1009);
  APPROX(r.finalState.acbPerUnit, 1009 / 10);
  assert.equal(r.finalState.quantity, 10);
});

// ---------------------------------------------------------------------------
// Stock split tests
// ---------------------------------------------------------------------------

function splitAct(tradeDate: string, splitRatio: number | null): AcbActivity {
  return {
    id: nextId++,
    tradeDate,
    activityType: 'split',
    quantity: null,
    amount: null,
    currency: 'CAD',
    fees: null,
    splitRatio,
  };
}

test('2-for-1 split doubles quantity, halves per-unit ACB, preserves total cost', () => {
  // BUY 10 @ $1000 → ACB $100/unit, totalCost $1000
  // SPLIT 2-for-1 → qty 20, ACB $50/unit, totalCost $1000 (unchanged)
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    splitAct('2024-06-15', 2),
  ]);
  assert.equal(r.finalState.quantity, 20);
  APPROX(r.finalState.totalCost, 1000);
  APPROX(r.finalState.acbPerUnit, 50);
  // Two timeline entries (BUY + SPLIT).
  assert.equal(r.timeline.length, 2);
  assert.equal(r.warnings.length, 0);
});

test('1-for-10 reverse split reduces quantity, raises per-unit ACB', () => {
  // BUY 100 @ $1000 → ACB $10/unit
  // REVERSE 1-for-10 (ratio 0.1) → qty 10, ACB $100/unit, totalCost $1000
  const r = computeAcb([
    act('2024-01-15', 'buy', 100, 1000),
    splitAct('2024-06-15', 0.1),
  ]);
  APPROX(r.finalState.quantity, 10);
  APPROX(r.finalState.totalCost, 1000);
  APPROX(r.finalState.acbPerUnit, 100);
  assert.equal(r.timeline.length, 2);
});

test('SELL after a split uses the post-split per-unit ACB', () => {
  // BUY 10 @ $1000 → ACB $100/unit
  // SPLIT 2-for-1 → qty 20, ACB $50/unit
  // SELL 5 @ $300 gross → cost removed 5*50=$250, gain $50
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    splitAct('2024-06-15', 2),
    act('2024-09-15', 'sell', 5, 300),
  ]);
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].acbPerUnitAtSale, 50);
  APPROX(r.realizedEvents[0].costRemoved, 250);
  APPROX(r.realizedEvents[0].realizedGain, 50);
  APPROX(r.finalState.quantity, 15);
  APPROX(r.finalState.acbPerUnit, 50);
});

test('split on a zero (closed) position emits a warning and is ignored', () => {
  // BUY 10 @ 1000, SELL 10 (close), then SPLIT 2:1
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-03-15', 'sell', 10, 1200), // close
    splitAct('2024-06-15', 2),
  ]);
  assert.ok(r.warnings.some((w) => /SPLIT.*zero position/i.test(w)));
  // Position remains closed; split was a no-op.
  assert.equal(r.finalState.quantity, 0);
  assert.equal(r.finalState.totalCost, 0);
});

test('split with null splitRatio emits a warning and is ignored', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    splitAct('2024-06-15', null),
  ]);
  assert.ok(r.warnings.some((w) => /missing or invalid splitRatio/i.test(w)));
  // Position unchanged.
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.acbPerUnit, 100);
});

test('3-for-1 mid-stream split produces correctly blended weighted-average ACB', () => {
  // BUY 10 @ $1000 → ACB $100/unit, totalCost $1000
  // SPLIT 3-for-1 → qty 30, ACB $33.333/unit, totalCost $1000
  // BUY 10 @ $500 → totalCost $1500, qty 40, ACB $37.5/unit
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    splitAct('2024-06-15', 3),
    act('2024-09-15', 'buy', 10, 500),
  ]);
  APPROX(r.finalState.quantity, 40);
  APPROX(r.finalState.totalCost, 1500);
  APPROX(r.finalState.acbPerUnit, 37.5);
});

// ---------------------------------------------------------------------------
// Return of capital (ROC) tests
// ---------------------------------------------------------------------------

test('ROC reduces total cost without changing quantity', () => {
  // BUY 10 @ $1000 → ACB $100/unit, totalCost $1000
  // ROC $50 → totalCost $950, qty 10, ACB $95/unit
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-06-15', 'return_of_capital', null, 50),
  ]);
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.totalCost, 950);
  APPROX(r.finalState.acbPerUnit, 95);
  assert.equal(r.realizedEvents.length, 0);
  assert.equal(r.timeline.length, 2);
});

test('multiple ROC events accumulate (each reduces cost)', () => {
  // BUY 10 @ $1000 → totalCost $1000
  // ROC $40 → totalCost $960
  // ROC $60 → totalCost $900, ACB $90/unit
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-04-15', 'return_of_capital', null, 40),
    act('2024-07-15', 'return_of_capital', null, 60),
  ]);
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.totalCost, 900);
  APPROX(r.finalState.acbPerUnit, 90);
  assert.equal(r.realizedEvents.length, 0);
});

test('ROC equal to total cost zeroes the ACB without producing a gain', () => {
  // BUY 10 @ $1000 → totalCost $1000
  // ROC $1000 → totalCost $0, ACB $0
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-06-15', 'return_of_capital', null, 1000),
  ]);
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.totalCost, 0);
  APPROX(r.finalState.acbPerUnit, 0);
  assert.equal(r.realizedEvents.length, 0);
});

test('ROC exceeding total cost emits a qtySold=0 realized event for the excess', () => {
  // BUY 10 @ $1000 → totalCost $1000
  // ROC $1200 → totalCost $0, $200 immediate capital gain
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-06-15', 'return_of_capital', null, 1200),
  ]);
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.totalCost, 0);
  APPROX(r.finalState.acbPerUnit, 0);
  assert.equal(r.realizedEvents.length, 1);
  assert.equal(r.realizedEvents[0].qtySold, 0);
  APPROX(r.realizedEvents[0].realizedGain, 200);
  APPROX(r.realizedEvents[0].proceeds, 200);
  APPROX(r.realizedTotal, 200);
  assert.ok(r.warnings.some((w) => /exceeds cost base/i.test(w)));
});

test('ROC with null amount emits a warning and does not crash', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-06-15', 'return_of_capital', null, null),
  ]);
  assert.ok(r.warnings.some((w) => /ROC.*missing amount/i.test(w)));
  // Position unchanged.
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.totalCost, 1000);
  APPROX(r.finalState.acbPerUnit, 100);
});

test('SELL after a ROC uses the reduced post-ROC ACB', () => {
  // BUY 10 @ $1000 → ACB $100/unit
  // ROC $200 → totalCost $800, ACB $80/unit
  // SELL 5 @ $600 → costRemoved 5*80=$400, gain $200
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-04-15', 'return_of_capital', null, 200),
    act('2024-07-15', 'sell', 5, 600),
  ]);
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].acbPerUnitAtSale, 80);
  APPROX(r.realizedEvents[0].costRemoved, 400);
  APPROX(r.realizedEvents[0].realizedGain, 200);
  APPROX(r.finalState.quantity, 5);
  APPROX(r.finalState.acbPerUnit, 80);
});

// ---------------------------------------------------------------------------
// Transfer in / transfer out tests
// ---------------------------------------------------------------------------

test('transfer_in into an empty position seeds qty + cost from book cost', () => {
  // TRANSFER_IN 10 @ $850 book → qty 10, totalCost $850, ACB $85/unit
  const r = computeAcb([act('2024-01-15', 'transfer_in', 10, 850)]);
  assert.equal(r.finalState.quantity, 10);
  APPROX(r.finalState.totalCost, 850);
  APPROX(r.finalState.acbPerUnit, 85);
  assert.equal(r.timeline.length, 1);
  assert.equal(r.realizedEvents.length, 0);
});

test('transfer_in onto an existing position blends weighted-average ACB', () => {
  // BUY 10 @ $1000 → ACB $100/unit
  // TRANSFER_IN 5 @ $400 book → totalCost $1400, qty 15, ACB ≈ $93.33/unit
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-06-15', 'transfer_in', 5, 400),
  ]);
  assert.equal(r.finalState.quantity, 15);
  APPROX(r.finalState.totalCost, 1400);
  APPROX(r.finalState.acbPerUnit, 1400 / 15);
});

test('transfer_in with null amount falls back to zero-cost and warns', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-06-15', 'transfer_in', 5, null),
  ]);
  assert.ok(r.warnings.some((w) => /TRANSFER_IN.*missing amount/i.test(w)));
  // qty grew, cost did not.
  assert.equal(r.finalState.quantity, 15);
  APPROX(r.finalState.totalCost, 1000);
  APPROX(r.finalState.acbPerUnit, 1000 / 15);
});

test('transfer_out removes qty at current ACB without producing a realized event', () => {
  // BUY 10 @ $1000 → ACB $100/unit
  // TRANSFER_OUT 4 → qty 6, totalCost preserved per-unit at $100
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-06-15', 'transfer_out', 4, null),
  ]);
  assert.equal(r.realizedEvents.length, 0);
  assert.equal(r.realizedTotal, 0);
  APPROX(r.finalState.quantity, 6);
  APPROX(r.finalState.acbPerUnit, 100);
  APPROX(r.finalState.totalCost, 600);
});

test('transfer_out that closes the position resets ACB and emits no realized event', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-06-15', 'transfer_out', 10, null),
  ]);
  assert.equal(r.realizedEvents.length, 0);
  assert.equal(r.finalState.quantity, 0);
  APPROX(r.finalState.totalCost, 0);
  APPROX(r.finalState.acbPerUnit, 0);
  assert.ok(r.warnings.some((w) => /Position closed/i.test(w)));
});

test('transfer_out exceeding position is clamped and warns', () => {
  // BUY 5, TRANSFER_OUT 8 → clamped to 5, position closes, no realized event
  const r = computeAcb([
    act('2024-01-15', 'buy', 5, 500),
    act('2024-06-15', 'transfer_out', 8, null),
  ]);
  assert.ok(r.warnings.some((w) => /TRANSFER_OUT.*exceeds position/i.test(w)));
  assert.equal(r.realizedEvents.length, 0);
  assert.equal(r.finalState.quantity, 0);
});

test('SELL after a transfer_in uses the blended ACB', () => {
  // BUY 10 @ $1000 → ACB $100
  // TRANSFER_IN 10 @ $500 book → qty 20, totalCost $1500, ACB $75
  // SELL 5 @ $400 → costRemoved 5*75=$375, gain $25
  const r = computeAcb([
    act('2024-01-15', 'buy', 10, 1000),
    act('2024-03-15', 'transfer_in', 10, 500),
    act('2024-06-15', 'sell', 5, 400),
  ]);
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].acbPerUnitAtSale, 75);
  APPROX(r.realizedEvents[0].costRemoved, 375);
  APPROX(r.realizedEvents[0].realizedGain, 25);
  APPROX(r.finalState.quantity, 15);
  APPROX(r.finalState.acbPerUnit, 75);
});

test('acb_adjustment adds to total cost without changing quantity', () => {
  // s.53(1)(f): a denied superficial loss is added back to the ACB of the
  // substituted shares. The synthetic acb_adjustment row carries that addback.
  const r = computeAcb([
    act('2024-01-15', 'buy', 100, 1000),
    act('2024-03-01', 'acb_adjustment', null, 300),
  ]);
  assert.equal(r.finalState.quantity, 100);
  assert.equal(r.finalState.totalCost, 1300);
  APPROX(r.finalState.acbPerUnit, 13);
  assert.equal(r.realizedEvents.length, 0, 'adjustment is not a disposition');
});

test('acb_adjustment raises the cost removed by a later sell', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 100, 750),
    act('2024-02-01', 'acb_adjustment', null, 300),
    act('2024-06-01', 'sell', 100, 900),
  ]);
  assert.equal(r.realizedEvents.length, 1);
  APPROX(r.realizedEvents[0].costRemoved, 1050, 'cost includes the addback');
  APPROX(r.realizedEvents[0].realizedGain, -150);
});

test('acb_adjustment on a closed position carries cost into the next buy', () => {
  // Sell-all then repurchase within the superficial window: the addback is
  // injected at the sell date (position momentarily zero) and must survive
  // into the repurchased lot's cost base rather than being reset.
  const r = computeAcb([
    act('2024-01-15', 'buy', 100, 1000),
    act('2024-03-01', 'sell', 100, 700),
    act('2024-03-01', 'acb_adjustment', null, 300),
    act('2024-03-10', 'buy', 100, 750),
  ]);
  assert.equal(r.finalState.quantity, 100);
  APPROX(r.finalState.totalCost, 1050, 'repurchased lot carries the denied loss');
});

test('acb_adjustment with null amount is ignored with a warning', () => {
  const r = computeAcb([
    act('2024-01-15', 'buy', 100, 1000),
    act('2024-02-01', 'acb_adjustment', null, null),
  ]);
  assert.equal(r.finalState.totalCost, 1000);
  assert.ok(r.warnings.some((w) => /ACB_ADJUSTMENT.*missing amount/i.test(w)));
});

// ---------------------------------------------------------------------------
// Staking reward tests (CRA: reward is income at FMV; FMV becomes cost base)
// ---------------------------------------------------------------------------

test('valued staking_reward adds quantity at FMV cost (weighted-average ACB)', () => {
  // BUY 10 @ cost 20 (negative amount convention), then reward 2 units valued 6.
  // Pool: qty 10 + 2 = 12, totalCost 20 + 6 = 26, acbPerUnit 26/12.
  const r = computeAcb([
    act('2025-01-01', 'buy', 10, -20),
    act('2025-02-01', 'staking_reward', 2, 6),
  ]);
  APPROX(r.finalState.quantity, 12, 'quantity should be 12');
  APPROX(r.finalState.totalCost, 26, 'totalCost should be 26');
  APPROX(r.finalState.acbPerUnit, 26 / 12, 'acbPerUnit should be 26/12');
});

test('unvalued staking_reward (amount 0) is ignored by ACB', () => {
  // BUY 10 @ cost 20, then unvalued reward — pool must stay 10 / 20.
  const r = computeAcb([
    act('2025-01-01', 'buy', 10, -20),
    act('2025-02-01', 'staking_reward', 2, 0),
  ]);
  APPROX(r.finalState.quantity, 10, 'quantity should remain 10');
  APPROX(r.finalState.totalCost, 20, 'totalCost should remain 20');
});
