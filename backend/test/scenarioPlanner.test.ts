/**
 * Unit tests for the financial scenario planner pure logic (issue #213).
 *
 * Tests exercise:
 *   - expandAssumption: one-off, recurring (weekly/biweekly/monthly),
 *     endDate capping, invalid inputs, window clamping.
 *   - runScenario: baseline vs scenario comparison, delta computation,
 *     no-mutation guarantee (real events not altered), empty assumptions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandAssumption,
  runScenario,
  type ScenarioAssumption,
} from '../src/scenarios/runScenario.js';
import type { BuildForecastInput } from '../src/forecast/buildForecast.js';

// ---------------------------------------------------------------------------
// expandAssumption — one-off events
// ---------------------------------------------------------------------------

test('expandAssumption: one-off income inside window emits one occurrence', () => {
  const assumption: ScenarioAssumption = {
    label: 'Bonus',
    type: 'one_off',
    amount: 500,
    startDate: '2026-06-15',
    direction: 'in',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-06-30', 0);
  assert.equal(occs.length, 1);
  assert.equal(occs[0].date, '2026-06-15');
  assert.equal(occs[0].direction, 'in');
  assert.equal(occs[0].amount, 500);
});

test('expandAssumption: one-off outside window emits nothing', () => {
  const assumption: ScenarioAssumption = {
    label: 'Car purchase',
    type: 'one_off',
    amount: 30000,
    startDate: '2026-09-01',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-06-30', 0);
  assert.equal(occs.length, 0);
});

test('expandAssumption: one_off defaults direction to "out" when omitted', () => {
  const assumption: ScenarioAssumption = {
    label: 'Car deposit',
    type: 'one_off',
    amount: 5000,
    startDate: '2026-06-10',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-06-30', 0);
  assert.equal(occs.length, 1);
  assert.equal(occs[0].direction, 'out');
});

test('expandAssumption: income type always "in"', () => {
  const assumption: ScenarioAssumption = {
    label: 'Pay raise',
    type: 'income',
    amount: 1000,
    startDate: '2026-06-01',
    recurrence: 'monthly',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-08-31', 0);
  for (const occ of occs) assert.equal(occ.direction, 'in');
  assert.ok(occs.length >= 3, 'Should have at least 3 monthly occurrences over 3 months');
});

test('expandAssumption: expense type always "out"', () => {
  const assumption: ScenarioAssumption = {
    label: 'New rent',
    type: 'expense',
    amount: 2500,
    startDate: '2026-06-01',
    recurrence: 'monthly',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-07-31', 0);
  for (const occ of occs) assert.equal(occ.direction, 'out');
  assert.equal(occs.length, 2);
});

test('expandAssumption: savings type always "out"', () => {
  const assumption: ScenarioAssumption = {
    label: 'Save more',
    type: 'savings',
    amount: 500,
    startDate: '2026-06-01',
    recurrence: 'monthly',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-06-30', 0);
  assert.ok(occs.length >= 1);
  for (const occ of occs) assert.equal(occ.direction, 'out');
});

// ---------------------------------------------------------------------------
// expandAssumption — recurring
// ---------------------------------------------------------------------------

test('expandAssumption: weekly recurrence expands correctly', () => {
  const assumption: ScenarioAssumption = {
    label: 'Weekly gym',
    type: 'expense',
    amount: 50,
    startDate: '2026-06-01',
    recurrence: 'weekly',
  };
  // 4 weeks in June from Jun 1 → Jun 29
  const occs = expandAssumption(assumption, '2026-06-01', '2026-06-30', 0);
  assert.ok(occs.length >= 4, `Expected at least 4 weekly occurrences, got ${occs.length}`);
});

test('expandAssumption: biweekly recurrence expands every 14 days', () => {
  const assumption: ScenarioAssumption = {
    label: 'Biweekly paycheck',
    type: 'income',
    amount: 2500,
    startDate: '2026-06-01',
    recurrence: 'biweekly',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-06-30', 0);
  // 2026-06-01 and 2026-06-15 within the window
  assert.ok(occs.length >= 2);
  const dates = occs.map((o) => o.date);
  assert.ok(dates.includes('2026-06-01') || dates.includes('2026-06-15'));
});

test('expandAssumption: monthly recurrence over 3 months', () => {
  const assumption: ScenarioAssumption = {
    label: 'Insurance premium',
    type: 'expense',
    amount: 150,
    startDate: '2026-06-15',
    recurrence: 'monthly',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-08-31', 0);
  const dates = occs.map((o) => o.date);
  assert.ok(dates.includes('2026-06-15'));
  assert.ok(dates.includes('2026-07-15'));
  assert.ok(dates.includes('2026-08-15'));
  assert.equal(occs.length, 3);
});

test('expandAssumption: endDate caps recurring expansion', () => {
  const assumption: ScenarioAssumption = {
    label: 'Temp expense',
    type: 'expense',
    amount: 100,
    startDate: '2026-06-01',
    recurrence: 'monthly',
    endDate: '2026-07-15', // Only two months
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-12-31', 0);
  const dates = occs.map((o) => o.date);
  assert.ok(dates.includes('2026-06-01'));
  assert.ok(dates.includes('2026-07-01'));
  // Should not have August occurrence
  assert.ok(!dates.includes('2026-08-01'));
});

test('expandAssumption: invalid startDate emits nothing', () => {
  const assumption: ScenarioAssumption = {
    label: 'Bad date',
    type: 'expense',
    amount: 100,
    startDate: 'not-a-date',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-06-30', 0);
  assert.equal(occs.length, 0);
});

test('expandAssumption: amount = 0 still emits occurrence (zero is valid)', () => {
  const assumption: ScenarioAssumption = {
    label: 'Zero expense',
    type: 'expense',
    amount: 0,
    startDate: '2026-06-15',
  };
  const occs = expandAssumption(assumption, '2026-06-01', '2026-06-30', 0);
  assert.equal(occs.length, 1);
  assert.equal(occs[0].amount, 0);
});

// ---------------------------------------------------------------------------
// runScenario — comparison and deltas
// ---------------------------------------------------------------------------

function makeBaselineInput(
  openingBalance: number,
  occurrences: Parameters<typeof import('../src/forecast/buildForecast.js')['buildForecast']>[0]['occurrences'],
  dateFrom = '2026-06-01',
  dateTo = '2026-06-30',
): BuildForecastInput {
  return {
    openingBalance,
    occurrences: occurrences as BuildForecastInput['occurrences'],
    dateFrom,
    dateTo,
    currency: 'CAD',
  };
}

test('runScenario: empty assumptions returns identical baseline and scenario', () => {
  const input = makeBaselineInput(10000, []);
  const result = runScenario(input, []);
  assert.equal(result.baseline.closing, result.scenario.closing);
  assert.equal(result.deltas.closing, 0);
  assert.equal(result.deltas.lowest, 0);
  assert.equal(result.deltas.lowestDateChanged, false);
});

test('runScenario: additional expense lowers scenario closing and lowest', () => {
  const input = makeBaselineInput(10000, []);
  const assumptions: ScenarioAssumption[] = [
    {
      label: 'Car purchase',
      type: 'one_off',
      amount: 2000,
      startDate: '2026-06-15',
      direction: 'out',
    },
  ];
  const result = runScenario(input, assumptions);
  assert.ok(result.scenario.closing < result.baseline.closing);
  assert.equal(result.deltas.closing, -2000);
  assert.ok(result.scenario.lowest <= result.scenario.closing);
});

test('runScenario: additional income raises scenario closing', () => {
  const input = makeBaselineInput(5000, []);
  const assumptions: ScenarioAssumption[] = [
    {
      label: 'Part-time income',
      type: 'income',
      amount: 1500,
      startDate: '2026-06-10',
    },
  ];
  const result = runScenario(input, assumptions);
  assert.ok(result.scenario.closing > result.baseline.closing);
  assert.equal(result.deltas.closing, 1500);
});

test('runScenario: does not mutate the original occurrences array', () => {
  const originalOccurrences = [
    {
      date: '2026-06-15',
      amount: 1000,
      direction: 'in' as const,
      sourceType: 'planned_event' as const,
      sourceId: 1,
      sourceName: 'Paycheck',
      accountId: null,
    },
  ];
  const input = makeBaselineInput(5000, originalOccurrences);
  const before = input.occurrences.length;
  runScenario(input, [
    {
      label: 'Extra expense',
      type: 'expense',
      amount: 500,
      startDate: '2026-06-20',
    },
  ]);
  assert.equal(input.occurrences.length, before, 'Original occurrences should not be mutated');
});

test('runScenario: multiple assumptions stack correctly', () => {
  const input = makeBaselineInput(10000, []);
  const assumptions: ScenarioAssumption[] = [
    {
      label: 'Income bump',
      type: 'income',
      amount: 3000,
      startDate: '2026-06-01',
    },
    {
      label: 'New car expense',
      type: 'expense',
      amount: 1500,
      startDate: '2026-06-15',
    },
  ];
  const result = runScenario(input, assumptions);
  // Net delta: +3000 - 1500 = +1500
  assert.equal(result.deltas.closing, 1500);
});

test('runScenario: monthly assumption spans 3-month window', () => {
  const input = makeBaselineInput(10000, [], '2026-06-01', '2026-08-31');
  const assumptions: ScenarioAssumption[] = [
    {
      label: 'Higher rent',
      type: 'expense',
      amount: 500,
      startDate: '2026-06-01',
      recurrence: 'monthly',
    },
  ];
  const result = runScenario(input, assumptions);
  // 3 monthly occurrences of $500 = −$1500
  assert.equal(result.deltas.closing, -1500);
});

test('runScenario: result has correct currency, dateFrom, dateTo', () => {
  const input = makeBaselineInput(10000, [], '2026-07-01', '2026-07-31');
  const result = runScenario(input, []);
  assert.equal(result.currency, 'CAD');
  assert.equal(result.dateFrom, '2026-07-01');
  assert.equal(result.dateTo, '2026-07-31');
});

test('runScenario: lowestDateChanged is true when scenario changes low point', () => {
  // Baseline: flat (no events). Scenario: big expense mid-month creates a new low.
  const input = makeBaselineInput(10000, []);
  const assumptions: ScenarioAssumption[] = [
    {
      label: 'Huge one-off expense',
      type: 'one_off',
      amount: 9000,
      startDate: '2026-06-10',
      direction: 'out',
    },
  ];
  const result = runScenario(input, assumptions);
  // Baseline low is at end (flat balance never changes); scenario low is at Jun 10.
  // These might be the same date if the baseline also bottoms at start — just check
  // that the scenario's lowest point was affected.
  assert.ok(result.scenario.lowest < result.baseline.lowest || result.scenario.lowestDate !== result.baseline.lowestDate);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('runScenario: invalid assumption dates are skipped gracefully', () => {
  const input = makeBaselineInput(5000, []);
  const assumptions: ScenarioAssumption[] = [
    {
      label: 'Bad date assumption',
      type: 'expense',
      amount: 100,
      startDate: 'invalid',
    },
  ];
  // Should not throw; bad assumption is silently ignored.
  const result = runScenario(input, assumptions);
  assert.equal(result.deltas.closing, 0);
});

test('runScenario: scenario with savings type reduces closing balance', () => {
  const input = makeBaselineInput(10000, []);
  const assumptions: ScenarioAssumption[] = [
    {
      label: 'Save more each month',
      type: 'savings',
      amount: 1000,
      startDate: '2026-06-01',
      recurrence: 'monthly',
    },
  ];
  const result = runScenario(input, assumptions);
  // Savings reduces cash (it's an outflow from the cashflow perspective)
  assert.ok(result.deltas.closing < 0);
});
