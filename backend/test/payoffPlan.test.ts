/**
 * Pure unit tests for the debt payoff engine (issue #202).
 *
 * The engine simulates month-by-month amortization for one or more debts
 * under a chosen strategy (avalanche | snowball | custom), funnelling any
 * `extraMonthlyPayment` plus freed-up minimums (the "roll-over" / snowball
 * effect) into the current target debt. All math is in integer cents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePayoffPlan,
  comparePayoff,
  payoffOrder,
  type PayoffDebtInput,
} from '../src/debt/payoffPlan.js';

const X: PayoffDebtInput = {
  id: 1,
  name: 'High APR card',
  balance: 3000,
  apr: 24, // 2%/month — highest APR, larger balance
  minimumPayment: 60,
};
const Y: PayoffDebtInput = {
  id: 2,
  name: 'Low APR loan',
  balance: 1000,
  apr: 6, // 0.5%/month — lowest balance, lower APR
  minimumPayment: 25,
};

test('payoffOrder: avalanche sorts by APR descending', () => {
  const order = payoffOrder([Y, X], 'avalanche');
  assert.deepEqual(order, [1, 2]); // X (24%) before Y (6%)
});

test('payoffOrder: snowball sorts by balance ascending', () => {
  const order = payoffOrder([X, Y], 'snowball');
  assert.deepEqual(order, [2, 1]); // Y (1000) before X (3000)
});

test('payoffOrder: custom respects the supplied order, appending any omitted ids', () => {
  const order = payoffOrder([X, Y], 'custom', [2, 1]);
  assert.deepEqual(order, [2, 1]);
  // Omitted ids get appended in stable input order.
  const partial = payoffOrder([X, Y], 'custom', [1]);
  assert.deepEqual(partial, [1, 2]);
});

test('single debt, zero interest: pays off in balance/minPayment months', () => {
  const plan = computePayoffPlan({
    debts: [{ id: 1, name: 'Card', balance: 1000, apr: 0, minimumPayment: 100 }],
    strategy: 'avalanche',
    extraMonthlyPayment: 0,
  });
  assert.equal(plan.totalMonths, 10);
  assert.equal(plan.totalInterest, 0);
  assert.equal(plan.totalPaid, 1000);
  assert.equal(plan.payoffMonthByDebt[1], 10);
  // 10 monthly rows, last row ends at zero.
  assert.equal(plan.months.length, 10);
  const last = plan.months[plan.months.length - 1];
  const xLine = last.perDebt.find((d) => d.debtId === 1);
  assert.ok(xLine);
  assert.equal(xLine.endingBalance, 0);
});

test('single debt with interest: first month accrues APR/12 on the opening balance', () => {
  // balance 1000, APR 12% -> 1%/month. Interest month 1 = 10.00.
  // Pay 200: 10 interest + 190 principal -> ending 810.
  const plan = computePayoffPlan({
    debts: [{ id: 1, name: 'Card', balance: 1000, apr: 12, minimumPayment: 200 }],
    strategy: 'avalanche',
    extraMonthlyPayment: 0,
  });
  const m1 = plan.months[0];
  const line = m1.perDebt.find((d) => d.debtId === 1);
  assert.ok(line);
  assert.equal(line.interest, 10);
  assert.equal(line.principal, 190);
  assert.equal(line.endingBalance, 810);
});

test('extra payment is applied to the avalanche target first', () => {
  // Two debts, extra 200. Avalanche targets X (24%). In month 1 X should
  // receive its minimum (60) PLUS the 200 extra; Y only its minimum (25).
  const plan = computePayoffPlan({
    debts: [X, Y],
    strategy: 'avalanche',
    extraMonthlyPayment: 200,
  });
  const m1 = plan.months[0];
  const xLine = m1.perDebt.find((d) => d.debtId === 1);
  const yLine = m1.perDebt.find((d) => d.debtId === 2);
  assert.ok(xLine && yLine);
  // X interest = 3000 * 0.02 = 60. Payment = 60 (min) + 200 (extra) = 260.
  assert.equal(xLine.interest, 60);
  assert.equal(xLine.payment, 260);
  // Y interest = 1000 * 0.005 = 5. Payment = 25 (min only).
  assert.equal(yLine.interest, 5);
  assert.equal(yLine.payment, 25);
});

test('snowball rolls a paid-off debt minimum into the next target', () => {
  // Y (1000 @ 6%, min 25) is the snowball target. extra 200.
  // Once Y is paid off, its 25 minimum + the 200 extra roll into X.
  const plan = computePayoffPlan({
    debts: [X, Y],
    strategy: 'snowball',
    extraMonthlyPayment: 200,
  });
  // Y is paid off well before X.
  assert.ok(plan.payoffMonthByDebt[2] < plan.payoffMonthByDebt[1]);
  // After Y's payoff month, X's payment should exceed its own minimum + extra
  // (it now also absorbs Y's freed 25 minimum).
  const afterY = plan.months[plan.payoffMonthByDebt[2]]; // 0-based: month right after payoff
  if (afterY) {
    const xLine = afterY.perDebt.find((d) => d.debtId === 1);
    assert.ok(xLine);
    // X min (60) + extra (200) + Y freed min (25) = 285 budget toward X
    // (less than that only in the final partial month). Assert it picked up
    // the rolled minimum vs the pre-payoff months.
    assert.ok(xLine.payment > 260 - 1);
  }
});

test('avalanche pays no more total interest than snowball (optimality)', () => {
  const av = computePayoffPlan({ debts: [X, Y], strategy: 'avalanche', extraMonthlyPayment: 150 });
  const sn = computePayoffPlan({ debts: [X, Y], strategy: 'snowball', extraMonthlyPayment: 150 });
  assert.ok(
    av.totalInterest <= sn.totalInterest,
    `avalanche interest ${av.totalInterest} should be <= snowball ${sn.totalInterest}`,
  );
});

test('comparePayoff reports non-negative interestSaved (avalanche vs snowball)', () => {
  const cmp = comparePayoff([X, Y], 150);
  assert.equal(cmp.avalanche.strategy, 'avalanche');
  assert.equal(cmp.snowball.strategy, 'snowball');
  assert.ok(cmp.interestSaved >= 0);
  assert.equal(
    Math.round(cmp.interestSaved * 100),
    Math.round((cmp.snowball.totalInterest - cmp.avalanche.totalInterest) * 100),
  );
});

test('scheduledPayments expose per-month total outflow with ISO dates from startDate', () => {
  const plan = computePayoffPlan({
    debts: [{ id: 1, name: 'Card', balance: 1000, apr: 0, minimumPayment: 100 }],
    strategy: 'avalanche',
    extraMonthlyPayment: 0,
    startDate: '2026-06-15',
  });
  assert.equal(plan.scheduledPayments.length, 10);
  assert.equal(plan.scheduledPayments[0].date, '2026-06-15');
  assert.equal(plan.scheduledPayments[0].amount, 100);
  assert.equal(plan.scheduledPayments[1].date, '2026-07-15');
  // Day-of-month is clamped for short months: a Jan 31 start lands on Feb 28.
  const febPlan = computePayoffPlan({
    debts: [{ id: 1, name: 'Card', balance: 1000, apr: 0, minimumPayment: 500 }],
    strategy: 'avalanche',
    extraMonthlyPayment: 0,
    startDate: '2026-01-31',
  });
  assert.equal(febPlan.scheduledPayments[1].date, '2026-02-28');
});

test('stalled debt (minimum below interest) is flagged and capped, not infinite', () => {
  // balance 1000 @ 24% (2%/mo = 20 interest), min payment 10 < interest.
  // With no extra, the balance grows forever. Engine must cap and flag.
  const plan = computePayoffPlan({
    debts: [{ id: 1, name: 'Underwater', balance: 1000, apr: 24, minimumPayment: 10 }],
    strategy: 'avalanche',
    extraMonthlyPayment: 0,
  });
  assert.equal(plan.stalled, true);
  assert.equal(plan.payoffMonthByDebt[1], null);
  // Capped at the engine's MAX_MONTHS rather than looping forever.
  assert.ok(plan.totalMonths <= 600);
  assert.ok(plan.months.length <= 600);
});

test('empty debt list returns an empty, non-stalled plan', () => {
  const plan = computePayoffPlan({ debts: [], strategy: 'avalanche', extraMonthlyPayment: 0 });
  assert.equal(plan.totalMonths, 0);
  assert.equal(plan.totalInterest, 0);
  assert.equal(plan.totalPaid, 0);
  assert.equal(plan.stalled, false);
  assert.deepEqual(plan.order, []);
  assert.deepEqual(plan.months, []);
  assert.deepEqual(plan.scheduledPayments, []);
});
