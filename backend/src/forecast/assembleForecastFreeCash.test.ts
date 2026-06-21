import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyFreeCashFromOccurrences } from './assembleForecast.js';
import { type ForecastOccurrence } from './buildForecast.js';

function occ(
  date: string,
  amount: number,
  direction: ForecastOccurrence['direction'],
): ForecastOccurrence {
  return {
    date,
    amount,
    direction,
    sourceType: 'planned_event',
    sourceId: 1,
    sourceName: 'x',
    accountId: null,
  };
}

test('monthlyFreeCash: net inflow over ~1 month window', () => {
  // 30-day window (2026-06-01..2026-06-30 = 30 days = ~0.986 months, floored
  // to a 1-month divisor). Income 3000 - expenses 1000 = 2000 net.
  const occs = [occ('2026-06-05', 3000, 'in'), occ('2026-06-10', 1000, 'out')];
  const v = monthlyFreeCashFromOccurrences(occs, '2026-06-01', '2026-06-30');
  assert.equal(v, 2000);
});

test('monthlyFreeCash: normalizes a multi-month window to per-month', () => {
  // ~3-month window (2026-06-01..2026-08-31 = 92 days ≈ 3.02 months).
  // Net = 9000 in. Per month ≈ 9000 / (92/30.4375) ≈ 2977.7.
  const occs = [
    occ('2026-06-15', 3000, 'in'),
    occ('2026-07-15', 3000, 'in'),
    occ('2026-08-15', 3000, 'in'),
  ];
  const v = monthlyFreeCashFromOccurrences(occs, '2026-06-01', '2026-08-31');
  assert.ok(Math.abs(v - 2977.7) < 1, `expected ~2977.7, got ${v}`);
});

test('monthlyFreeCash: ignores neutral occurrences (transfers)', () => {
  const occs = [
    occ('2026-06-05', 3000, 'in'),
    occ('2026-06-06', 5000, 'neutral'),
  ];
  const v = monthlyFreeCashFromOccurrences(occs, '2026-06-01', '2026-06-30');
  assert.equal(v, 3000);
});

test('monthlyFreeCash: negative when outflows exceed inflows', () => {
  const occs = [occ('2026-06-05', 500, 'in'), occ('2026-06-10', 2000, 'out')];
  const v = monthlyFreeCashFromOccurrences(occs, '2026-06-01', '2026-06-30');
  assert.equal(v, -1500);
});

test('monthlyFreeCash: drops occurrences outside the window', () => {
  const occs = [
    occ('2026-05-31', 9999, 'in'), // before window
    occ('2026-07-01', 9999, 'in'), // after window
    occ('2026-06-15', 1000, 'in'),
  ];
  const v = monthlyFreeCashFromOccurrences(occs, '2026-06-01', '2026-06-30');
  assert.equal(v, 1000);
});

test('monthlyFreeCash: zero when no occurrences', () => {
  assert.equal(monthlyFreeCashFromOccurrences([], '2026-06-01', '2026-06-30'), 0);
});
