/**
 * Pure tests for the safe-to-spend surplus decision hub (#654).
 *
 * Exercises `composeSurplus` (surplus amount, payoff-vs-invest math) and
 * `selectTopGoal` (priority then nearest targetDate) without touching the DB.
 * Pairs with the route + integration coverage for the DB-backed path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeSurplus,
  selectTopGoal,
  DEFAULT_ASSUMED_ANNUAL_RETURN_RATE,
  DEFAULT_SURPLUS_HORIZON_YEARS,
  type ComposeSurplusInput,
} from './surplus';
import { computeOpportunityCost } from './opportunityCost';
import { comparePayoff, type PayoffDebtInput } from '../debt/payoffPlan';

function baseInput(over: Partial<ComposeSurplusInput> = {}): ComposeSurplusInput {
  return {
    safeToSpendValue: 1200,
    buffer: 100,
    currency: 'CAD',
    topGoal: null,
    debts: [],
    assumedAnnualReturnRate: DEFAULT_ASSUMED_ANNUAL_RETURN_RATE,
    horizonYears: DEFAULT_SURPLUS_HORIZON_YEARS,
    ...over,
  };
}

// --- AC 1: surplus = max(0, value) ---------------------------------------

test('composeSurplus: positive value passes through as surplus amount', () => {
  const r = composeSurplus(baseInput({ safeToSpendValue: 1200 }));
  assert.equal(r.amount, 1200);
});

test('composeSurplus: negative value clamps surplus to 0', () => {
  const r = composeSurplus(baseInput({ safeToSpendValue: -50 }));
  assert.equal(r.amount, 0);
});

test('composeSurplus: zero value yields zero surplus', () => {
  const r = composeSurplus(baseInput({ safeToSpendValue: 0 }));
  assert.equal(r.amount, 0);
});

// --- AC 2: buffer is the deducted minimum buffer -------------------------

test('composeSurplus: buffer echoes the deducted minimum buffer', () => {
  const r = composeSurplus(baseInput({ buffer: 250 }));
  assert.equal(r.buffer, 250);
});

// --- AC 3 + 4: top goal selection ----------------------------------------

test('selectTopGoal: highest priority wins', () => {
  const top = selectTopGoal([
    { id: 1, name: 'Low', currency: 'CAD', priority: 1, targetDate: null },
    { id: 2, name: 'High', currency: 'CAD', priority: 5, targetDate: null },
  ]);
  assert.deepEqual(top, { id: 2, name: 'High', currency: 'CAD' });
});

test('selectTopGoal: ties on priority broken by nearest targetDate', () => {
  const top = selectTopGoal([
    { id: 1, name: 'Later', currency: 'CAD', priority: 3, targetDate: '2027-01-01' },
    { id: 2, name: 'Sooner', currency: 'CAD', priority: 3, targetDate: '2026-09-01' },
  ]);
  assert.equal(top?.id, 2);
  assert.equal(top?.name, 'Sooner');
});

test('selectTopGoal: a dated goal beats an undated one on a priority tie', () => {
  const top = selectTopGoal([
    { id: 1, name: 'NoDate', currency: 'CAD', priority: 3, targetDate: null },
    { id: 2, name: 'Dated', currency: 'CAD', priority: 3, targetDate: '2027-01-01' },
  ]);
  assert.equal(top?.id, 2);
});

test('selectTopGoal: empty list yields null', () => {
  assert.equal(selectTopGoal([]), null);
});

test('composeSurplus: passes the pre-selected top goal through', () => {
  const goal = { id: 7, name: 'House', currency: 'CAD' };
  const r = composeSurplus(baseInput({ topGoal: goal }));
  assert.deepEqual(r.topGoal, goal);
});

test('composeSurplus: no goal yields null topGoal', () => {
  const r = composeSurplus(baseInput({ topGoal: null }));
  assert.equal(r.topGoal, null);
});

// --- AC 5 + 6: payoff vs invest ------------------------------------------

const HEAVY_DEBT: PayoffDebtInput[] = [
  { id: 1, name: 'Card A', balance: 8000, apr: 24.99, minimumPayment: 100 },
  { id: 2, name: 'Card B', balance: 3000, apr: 12.5, minimumPayment: 60 },
];

test('composeSurplus: interestSaved comes from comparePayoff over the surplus', () => {
  const surplus = 2000;
  const r = composeSurplus(
    baseInput({ safeToSpendValue: surplus, debts: HEAVY_DEBT }),
  );
  const expected = comparePayoff(HEAVY_DEBT, surplus).interestSaved;
  assert.ok(r.payoffVsInvest);
  assert.equal(r.payoffVsInvest.interestSaved, Math.round(expected * 100) / 100);
});

test('composeSurplus: investGain matches one-time computeOpportunityCost', () => {
  const surplus = 2000;
  const r = composeSurplus(
    baseInput({
      safeToSpendValue: surplus,
      debts: HEAVY_DEBT,
      assumedAnnualReturnRate: 0.05,
      horizonYears: 10,
    }),
  );
  const expected = computeOpportunityCost({
    mode: 'one-time',
    amount: surplus,
    horizonYears: 10,
    annualReturnRate: 0.05,
  }).gain;
  assert.ok(r.payoffVsInvest);
  assert.equal(r.payoffVsInvest.investGain, Math.round(expected * 100) / 100);
});

test('composeSurplus: recommendation is invest when investGain > interestSaved', () => {
  // Low-APR debt + healthy return + long horizon → invest wins.
  const lowApr: PayoffDebtInput[] = [
    { id: 1, name: 'Cheap loan', balance: 1000, apr: 1, minimumPayment: 500 },
  ];
  const r = composeSurplus(
    baseInput({
      safeToSpendValue: 5000,
      debts: lowApr,
      assumedAnnualReturnRate: 0.08,
      horizonYears: 20,
    }),
  );
  assert.ok(r.payoffVsInvest);
  assert.equal(r.payoffVsInvest.recommendation, 'invest');
  assert.ok(r.payoffVsInvest.investGain > r.payoffVsInvest.interestSaved);
});

test('composeSurplus: recommendation is tie when both gains equal (zero each)', () => {
  // A single debt has interestSaved === 0 from comparePayoff (snowball ===
  // avalanche with one debt), and a 0% return yields investGain 0 → tie.
  const oneDebt: PayoffDebtInput[] = [
    { id: 1, name: 'Only', balance: 1000, apr: 10, minimumPayment: 50 },
  ];
  const r = composeSurplus(
    baseInput({
      safeToSpendValue: 500,
      debts: oneDebt,
      assumedAnnualReturnRate: 0,
      horizonYears: 10,
    }),
  );
  assert.ok(r.payoffVsInvest);
  assert.equal(r.payoffVsInvest.interestSaved, 0);
  assert.equal(r.payoffVsInvest.investGain, 0);
  assert.equal(r.payoffVsInvest.recommendation, 'tie');
});

// --- AC 7: no debt → null panel ------------------------------------------

test('composeSurplus: no debt yields null payoffVsInvest', () => {
  const r = composeSurplus(baseInput({ safeToSpendValue: 1200, debts: [] }));
  assert.equal(r.payoffVsInvest, null);
});

test('composeSurplus: zero surplus yields null payoffVsInvest even with debt', () => {
  const r = composeSurplus(
    baseInput({ safeToSpendValue: 0, debts: HEAVY_DEBT }),
  );
  assert.equal(r.amount, 0);
  assert.equal(r.payoffVsInvest, null);
});

// --- AC 8: rate defaults + clamp -----------------------------------------

test('composeSurplus: out-of-range rate is clamped into [0,1]', () => {
  const r = composeSurplus(
    baseInput({
      safeToSpendValue: 1000,
      debts: HEAVY_DEBT,
      assumedAnnualReturnRate: 5, // 500% — clamps to 1
    }),
  );
  assert.ok(r.payoffVsInvest);
  assert.equal(r.payoffVsInvest.assumedAnnualReturnRate, 1);
});

test('DEFAULT_ASSUMED_ANNUAL_RETURN_RATE is 0.05 and horizon is 10', () => {
  assert.equal(DEFAULT_ASSUMED_ANNUAL_RETURN_RATE, 0.05);
  assert.equal(DEFAULT_SURPLUS_HORIZON_YEARS, 10);
});

// --- AC 11: rounding -----------------------------------------------------

test('composeSurplus: surplus amount is rounded to 2 decimals', () => {
  const r = composeSurplus(baseInput({ safeToSpendValue: 1200.456 }));
  assert.equal(r.amount, 1200.46);
});
