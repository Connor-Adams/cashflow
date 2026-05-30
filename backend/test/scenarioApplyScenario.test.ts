/**
 * Unit tests for the pure scenario engine (issue #213).
 *
 * `applyScenario` takes already-collected base inputs (opening balance,
 * forecast occurrences, safe-to-spend breakdown numbers, current net worth)
 * plus a list of hypothetical assumptions, and returns base / scenario /
 * deltas across projected balance, lowest projected balance, safe-to-spend
 * and net worth — WITHOUT touching the database. The route layer gathers the
 * inputs; this engine does the math so it can be exercised in isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyScenario,
  type ScenarioAssumption,
  type ScenarioInputs,
} from '../src/scenarios/applyScenario';
import type { ForecastOccurrence } from '../src/forecast/buildForecast';

const SETTINGS = {
  minimumCashBuffer: '0.0000',
  safeToSpendWindowDays: 14,
  includeCreditCardBalance: true,
  includeGoalContributions: true,
};

function occ(
  partial: Partial<ForecastOccurrence> & {
    date: string;
    amount: number;
    direction: ForecastOccurrence['direction'];
  },
): ForecastOccurrence {
  return {
    sourceType: 'planned_event',
    sourceId: 1,
    sourceName: 'x',
    accountId: null,
    ...partial,
  };
}

function baseInputs(overrides: Partial<ScenarioInputs> = {}): ScenarioInputs {
  return {
    openingBalance: 5000,
    occurrences: [],
    dateFrom: '2026-06-01',
    dateTo: '2026-08-30',
    currency: 'CAD',
    currentCash: 5000,
    upcomingRequiredExpenses: 0,
    requiredSavingsContributions: 0,
    expectedCreditCardPayments: 0,
    minimumBuffer: 0,
    settings: SETTINGS,
    currentNetWorth: 12000,
    ...overrides,
  };
}

test('empty assumptions → scenario equals base, zero deltas', () => {
  const inputs = baseInputs({
    occurrences: [
      occ({ date: '2026-06-15', amount: 2000, direction: 'in' }),
      occ({ date: '2026-06-20', amount: 500, direction: 'out' }),
    ],
  });
  const out = applyScenario(inputs, []);

  assert.equal(out.base.projectedClosingBalance, 6500); // 5000 + 2000 - 500
  assert.equal(out.scenario.projectedClosingBalance, 6500);
  assert.equal(out.deltas.projectedClosingBalance, 0);
  assert.equal(out.deltas.safeToSpend, 0);
  assert.equal(out.deltas.netWorth, 0);
  // Net worth base reflects the supplied current net worth.
  assert.equal(out.base.netWorth, 12000);
});

test('income_pct -0.3 reduces income occurrences by 30%', () => {
  const inputs = baseInputs({
    occurrences: [occ({ date: '2026-06-15', amount: 4000, direction: 'in' })],
  });
  const assumptions: ScenarioAssumption[] = [{ kind: 'income_pct', pct: -0.3 }];
  const out = applyScenario(inputs, assumptions);

  // base closing: 5000 + 4000 = 9000
  assert.equal(out.base.projectedClosingBalance, 9000);
  // scenario: income scaled to 2800 → 5000 + 2800 = 7800
  assert.equal(out.scenario.projectedClosingBalance, 7800);
  assert.equal(out.deltas.projectedClosingBalance, -1200);
  // Net worth moves by the same cash delta.
  assert.equal(out.deltas.netWorth, -1200);
});

test('income_pct does not touch expense occurrences', () => {
  const inputs = baseInputs({
    occurrences: [
      occ({ date: '2026-06-15', amount: 1000, direction: 'in' }),
      occ({ date: '2026-06-16', amount: 1000, direction: 'out' }),
    ],
  });
  const out = applyScenario(inputs, [{ kind: 'income_pct', pct: 1 }]); // +100% income
  // base: 5000 + 1000 - 1000 = 5000
  assert.equal(out.base.projectedClosingBalance, 5000);
  // scenario: income doubled to 2000 → 5000 + 2000 - 1000 = 6000
  assert.equal(out.scenario.projectedClosingBalance, 6000);
});

test('expense_pct +0.5 increases outflow occurrences by 50%', () => {
  const inputs = baseInputs({
    occurrences: [occ({ date: '2026-06-10', amount: 1000, direction: 'out' })],
  });
  const out = applyScenario(inputs, [{ kind: 'expense_pct', pct: 0.5 }]);
  // base: 5000 - 1000 = 4000
  assert.equal(out.base.projectedClosingBalance, 4000);
  // scenario: expense scaled to 1500 → 5000 - 1500 = 3500
  assert.equal(out.scenario.projectedClosingBalance, 3500);
  assert.equal(out.deltas.projectedClosingBalance, -500);
});

test('savings_monthly adds a recurring monthly outflow across the horizon', () => {
  // Window 2026-06-01 .. 2026-08-30 spans 3 month-starts: Jun 1, Jul 1, Aug 1.
  const inputs = baseInputs({ openingBalance: 5000, occurrences: [] });
  const out = applyScenario(inputs, [{ kind: 'savings_monthly', amount: 1000 }]);
  assert.equal(out.base.projectedClosingBalance, 5000);
  // 3 monthly contributions of 1000 leave the cashflow accounts.
  assert.equal(out.scenario.projectedClosingBalance, 2000);
  assert.equal(out.deltas.projectedClosingBalance, -3000);
});

test('one_off out event reduces projected balance', () => {
  const inputs = baseInputs({ openingBalance: 5000, occurrences: [] });
  const out = applyScenario(inputs, [
    { kind: 'one_off', date: '2026-07-01', amount: 25000, direction: 'out' },
  ]);
  assert.equal(out.scenario.projectedClosingBalance, -20000);
  assert.equal(out.deltas.projectedClosingBalance, -25000);
  // lowest projected balance should also reflect the dip.
  assert.equal(out.scenario.lowestProjectedBalance, -20000);
});

test('one_off in event increases projected balance', () => {
  const inputs = baseInputs({ openingBalance: 5000, occurrences: [] });
  const out = applyScenario(inputs, [
    { kind: 'one_off', date: '2026-07-01', amount: 3000, direction: 'in' },
  ]);
  assert.equal(out.scenario.projectedClosingBalance, 8000);
  assert.equal(out.deltas.projectedClosingBalance, 3000);
});

test('safe-to-spend reflects an in-window one_off out as a required expense', () => {
  // asOfDate defaults to dateFrom; window 14 days → 2026-06-01..2026-06-15.
  const inputs = baseInputs({
    currentCash: 5000,
    openingBalance: 5000,
  });
  const out = applyScenario(inputs, [
    { kind: 'one_off', date: '2026-06-05', amount: 800, direction: 'out' },
  ]);
  // base safe-to-spend = 5000 (no deductions)
  assert.equal(out.base.safeToSpend, 5000);
  // scenario safe-to-spend = 5000 - 800 = 4200
  assert.equal(out.scenario.safeToSpend, 4200);
  assert.equal(out.deltas.safeToSpend, -800);
});

test('one_off out beyond the safe-to-spend window does not reduce safe-to-spend', () => {
  const inputs = baseInputs({ currentCash: 5000, openingBalance: 5000 });
  // 60 days out — beyond the 14-day STS window but inside the 90-day forecast.
  const out = applyScenario(inputs, [
    { kind: 'one_off', date: '2026-07-31', amount: 800, direction: 'out' },
  ]);
  assert.equal(out.scenario.safeToSpend, 5000);
  assert.equal(out.deltas.safeToSpend, 0);
  // But the forecast closing balance still drops.
  assert.equal(out.deltas.projectedClosingBalance, -800);
});

test('savings_monthly reduces safe-to-spend by one in-window contribution', () => {
  // 14-day window contains exactly the Jun 1 monthly contribution.
  const inputs = baseInputs({ currentCash: 5000, openingBalance: 5000 });
  const out = applyScenario(inputs, [{ kind: 'savings_monthly', amount: 600 }]);
  // base STS 5000; scenario subtracts the single in-window contribution.
  assert.equal(out.base.safeToSpend, 5000);
  assert.equal(out.scenario.safeToSpend, 4400);
});

test('multiple assumptions compose (income drop + expense rise)', () => {
  const inputs = baseInputs({
    openingBalance: 5000,
    occurrences: [
      occ({ date: '2026-06-15', amount: 4000, direction: 'in' }),
      occ({ date: '2026-06-20', amount: 2000, direction: 'out' }),
    ],
  });
  const out = applyScenario(inputs, [
    { kind: 'income_pct', pct: -0.25 },
    { kind: 'expense_pct', pct: 0.1 },
  ]);
  // base: 5000 + 4000 - 2000 = 7000
  assert.equal(out.base.projectedClosingBalance, 7000);
  // scenario income: 3000, expense: 2200 → 5000 + 3000 - 2200 = 5800
  assert.equal(out.scenario.projectedClosingBalance, 5800);
  assert.equal(out.deltas.projectedClosingBalance, -1200);
});

test('net worth scenario = currentNetWorth + cash delta', () => {
  const inputs = baseInputs({
    openingBalance: 5000,
    currentNetWorth: 20000,
    occurrences: [occ({ date: '2026-06-15', amount: 1000, direction: 'out' })],
  });
  const out = applyScenario(inputs, [
    { kind: 'one_off', date: '2026-07-01', amount: 4000, direction: 'out' },
  ]);
  // base closing 4000, scenario closing 0 → cash delta -4000.
  assert.equal(out.base.netWorth, 20000);
  assert.equal(out.scenario.netWorth, 16000);
  assert.equal(out.deltas.netWorth, -4000);
});

test('neutral occurrences are ignored by the forecast (no balance impact)', () => {
  const inputs = baseInputs({
    openingBalance: 5000,
    occurrences: [occ({ date: '2026-06-15', amount: 9999, direction: 'neutral' })],
  });
  const out = applyScenario(inputs, [{ kind: 'income_pct', pct: 0.5 }]);
  assert.equal(out.base.projectedClosingBalance, 5000);
  assert.equal(out.scenario.projectedClosingBalance, 5000);
});

test('income_pct pct = 0 is a no-op', () => {
  const inputs = baseInputs({
    occurrences: [occ({ date: '2026-06-15', amount: 1000, direction: 'in' })],
  });
  const out = applyScenario(inputs, [{ kind: 'income_pct', pct: 0 }]);
  assert.equal(out.scenario.projectedClosingBalance, out.base.projectedClosingBalance);
});

test('results round to 2 decimals', () => {
  const inputs = baseInputs({
    occurrences: [occ({ date: '2026-06-15', amount: 1000, direction: 'in' })],
  });
  const out = applyScenario(inputs, [{ kind: 'income_pct', pct: -0.333 }]);
  // 1000 * 0.667 = 667; closing = 5667
  assert.equal(out.scenario.projectedClosingBalance, 5667);
  assert.equal(Number.isInteger(out.deltas.projectedClosingBalance * 100), true);
});
