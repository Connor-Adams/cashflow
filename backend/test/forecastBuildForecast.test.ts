import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildForecast,
  type ForecastOccurrence,
} from '../src/forecast/buildForecast';

/**
 * Pure tests for buildForecast — the projection engine that turns:
 *   - opening cash balance (one currency, after netting accounts)
 *   - a list of dated occurrences (already expanded from recurrence)
 * into the response shape the GET /forecast endpoint returns.
 */

function makeOccurrence(
  partial: Partial<ForecastOccurrence>,
): ForecastOccurrence {
  return {
    date: '2026-06-15',
    amount: 100,
    direction: 'in',
    sourceType: 'planned_event',
    sourceId: 1,
    sourceName: 'Test',
    accountId: null,
    ...partial,
  };
}

test('buildForecast: empty events → flat line from opening to closing balance', () => {
  const result = buildForecast({
    openingBalance: 1000,
    occurrences: [],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-03',
    currency: 'CAD',
  });
  assert.equal(result.openingBalance, 1000);
  assert.equal(result.projectedClosingBalance, 1000);
  assert.equal(result.lowestProjectedBalance, 1000);
  assert.equal(result.dailyPoints.length, 3);
  assert.equal(result.dailyPoints[0].date, '2026-06-01');
  assert.equal(result.dailyPoints[0].balance, 1000);
  assert.equal(result.dailyPoints[2].date, '2026-06-03');
  assert.equal(result.dailyPoints[2].balance, 1000);
});

test('buildForecast: one inflow raises balance from its date onward', () => {
  const result = buildForecast({
    openingBalance: 100,
    occurrences: [
      makeOccurrence({ date: '2026-06-02', amount: 50, direction: 'in' }),
    ],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-03',
    currency: 'CAD',
  });
  assert.equal(result.dailyPoints[0].balance, 100);
  assert.equal(result.dailyPoints[1].balance, 150);
  assert.equal(result.dailyPoints[2].balance, 150);
  assert.equal(result.projectedClosingBalance, 150);
  assert.equal(result.lowestProjectedBalance, 100);
});

test('buildForecast: one outflow drops balance from its date onward', () => {
  const result = buildForecast({
    openingBalance: 1000,
    occurrences: [
      makeOccurrence({ date: '2026-06-02', amount: 400, direction: 'out' }),
    ],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-03',
    currency: 'CAD',
  });
  assert.equal(result.dailyPoints[0].balance, 1000);
  assert.equal(result.dailyPoints[1].balance, 600);
  assert.equal(result.dailyPoints[2].balance, 600);
  assert.equal(result.projectedClosingBalance, 600);
  assert.equal(result.lowestProjectedBalance, 600);
});

test('buildForecast: multiple events on same day net together', () => {
  const result = buildForecast({
    openingBalance: 500,
    occurrences: [
      makeOccurrence({ date: '2026-06-02', amount: 100, direction: 'in' }),
      makeOccurrence({ date: '2026-06-02', amount: 30, direction: 'out' }),
    ],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-03',
    currency: 'CAD',
  });
  assert.equal(result.dailyPoints[0].balance, 500);
  assert.equal(result.dailyPoints[1].balance, 570);
});

test('buildForecast: lowest balance reflects mid-range dip (not just closing)', () => {
  const result = buildForecast({
    openingBalance: 1000,
    occurrences: [
      makeOccurrence({ date: '2026-06-02', amount: 900, direction: 'out' }),
      makeOccurrence({ date: '2026-06-04', amount: 500, direction: 'in' }),
    ],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-05',
    currency: 'CAD',
  });
  assert.equal(result.openingBalance, 1000);
  // Day 2-3 = 100; day 4-5 = 600. Closing = 600 but lowest = 100.
  assert.equal(result.lowestProjectedBalance, 100);
  assert.equal(result.projectedClosingBalance, 600);
  const lowDay = result.dailyPoints.find((p) => p.balance === 100);
  assert.ok(lowDay);
});

test('buildForecast: events outside [dateFrom, dateTo] are ignored', () => {
  const result = buildForecast({
    openingBalance: 100,
    occurrences: [
      makeOccurrence({ date: '2026-05-31', amount: 999, direction: 'in' }),
      makeOccurrence({ date: '2026-06-04', amount: 999, direction: 'out' }),
    ],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-03',
    currency: 'CAD',
  });
  // Both should be filtered out — no change in balance.
  assert.equal(result.projectedClosingBalance, 100);
  assert.equal(result.lowestProjectedBalance, 100);
});

test('buildForecast: transfer occurrences (direction "neutral") do not move balance', () => {
  // A transfer between own accounts is a wash at the household level.
  const result = buildForecast({
    openingBalance: 500,
    occurrences: [
      makeOccurrence({ date: '2026-06-02', amount: 300, direction: 'neutral' }),
    ],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-03',
    currency: 'CAD',
  });
  assert.equal(result.projectedClosingBalance, 500);
  assert.equal(result.lowestProjectedBalance, 500);
});

test('buildForecast: every day in [dateFrom, dateTo] is present in dailyPoints', () => {
  const result = buildForecast({
    openingBalance: 0,
    occurrences: [],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-07',
    currency: 'CAD',
  });
  assert.equal(result.dailyPoints.length, 7);
  assert.deepEqual(
    result.dailyPoints.map((p) => p.date),
    [
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
      '2026-06-06',
      '2026-06-07',
    ],
  );
});

test('buildForecast: handles negative opening balance and going further negative', () => {
  // Credit-card style: starting in debt, more debt added.
  const result = buildForecast({
    openingBalance: -200,
    occurrences: [
      makeOccurrence({ date: '2026-06-02', amount: 50, direction: 'out' }),
      makeOccurrence({ date: '2026-06-03', amount: 100, direction: 'in' }),
    ],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-04',
    currency: 'CAD',
  });
  assert.equal(result.dailyPoints[0].balance, -200);
  assert.equal(result.dailyPoints[1].balance, -250);
  assert.equal(result.dailyPoints[2].balance, -150);
  assert.equal(result.lowestProjectedBalance, -250);
});

test('buildForecast: lowestProjectedBalance carries the date it occurs on', () => {
  const result = buildForecast({
    openingBalance: 500,
    occurrences: [
      makeOccurrence({ date: '2026-06-03', amount: 600, direction: 'out' }),
      makeOccurrence({ date: '2026-06-04', amount: 700, direction: 'in' }),
    ],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-05',
    currency: 'CAD',
  });
  assert.equal(result.lowestProjectedBalance, -100);
  assert.equal(result.lowestProjectedBalanceDate, '2026-06-03');
});

test('buildForecast: amounts are summed losslessly across many small charges', () => {
  // 100 charges of 1.23 each should net exactly 123.00, not 122.9999...
  const occurrences: ForecastOccurrence[] = [];
  for (let i = 0; i < 100; i++) {
    occurrences.push(
      makeOccurrence({ date: '2026-06-02', amount: 1.23, direction: 'out' }),
    );
  }
  const result = buildForecast({
    openingBalance: 200,
    occurrences,
    dateFrom: '2026-06-01',
    dateTo: '2026-06-03',
    currency: 'CAD',
  });
  // 200 - (100 * 1.23) = 77.00 exactly
  assert.equal(result.projectedClosingBalance, 77);
});

test('buildForecast: dailyPoints balances are rounded to 2 decimals', () => {
  // 3 charges of 0.333... each should net to 1.0 exactly; the engine
  // rounds final daily values to 2dp to avoid 0.9999999...
  const result = buildForecast({
    openingBalance: 0,
    occurrences: [
      makeOccurrence({ date: '2026-06-02', amount: 0.333, direction: 'in' }),
      makeOccurrence({ date: '2026-06-02', amount: 0.333, direction: 'in' }),
      makeOccurrence({ date: '2026-06-02', amount: 0.334, direction: 'in' }),
    ],
    dateFrom: '2026-06-01',
    dateTo: '2026-06-03',
    currency: 'CAD',
  });
  assert.equal(result.dailyPoints[1].balance, 1);
  assert.equal(result.projectedClosingBalance, 1);
});

test('buildForecast: empty range (dateTo < dateFrom) returns zero-day series', () => {
  const result = buildForecast({
    openingBalance: 100,
    occurrences: [],
    dateFrom: '2026-06-10',
    dateTo: '2026-06-01',
    currency: 'CAD',
  });
  assert.equal(result.dailyPoints.length, 0);
  assert.equal(result.openingBalance, 100);
  assert.equal(result.projectedClosingBalance, 100);
  assert.equal(result.lowestProjectedBalance, 100);
});
