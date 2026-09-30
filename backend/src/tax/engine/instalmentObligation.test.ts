/**
 * Whether instalments are required at all, and how much.
 *
 * The CRA test has two conjuncts and the second is the whole point: net tax owing
 * must exceed the threshold in the CURRENT year **and** in either of the two
 * preceding years. A naive "> $3,000 ⇒ pay" would have told Connor he was late for
 * all of 2026, accruing interest, when in fact nothing was owed.
 *
 * His actual three-year window, from prod `tax_return_snapshots`:
 *
 *   2024  net owing $0.00        (id 3: totalIncome 98.79, totalPayable 0.00)
 *   2025  a refund of $47.35     (id 2: totalPayable 3,727.81 less T4 withholding 3,775.16)
 *   2026  ~$8,400-$16,610
 *
 * So 2026 requires nothing, because both prior years were under the threshold — and
 * 2027 will, because 2026 is over it. Both halves matter: the first is reassurance he
 * is not already late, the second is a deadline of 2027-03-15.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import {
  INSTALMENT_THRESHOLD,
  instalmentObligation,
  quarterlyInstalments,
  noCalculationInstalments,
} from './instalments';

const owing = (currentYear: string, prior: string, priorPrior: string) => ({
  currentYear: D(currentYear),
  priorYear: D(prior),
  twoYearsPrior: D(priorPrior),
});

test('the threshold is the CRA $3,000', () => {
  assert.equal(INSTALMENT_THRESHOLD.toFixed(2), '3000.00');
});

test("Connor's 2026: over the threshold this year, under it in both prior years → not required", () => {
  const got = instalmentObligation({ year: 2026, netOwing: owing('8400', '-47.35', '0') });
  assert.equal(got.required, false);
  // The reason must name both prior years and their figures, not just say "no":
  // the reassurance only lands if he can see WHY he is not late.
  assert.match(got.reason, /2025 \(-47\.35\)/);
  assert.match(got.reason, /2024 \(0\.00\)/);
  assert.deepEqual(got.instalments, []);
});

test("Connor's 2027: the prior year is now over the threshold → required", () => {
  const got = instalmentObligation({ year: 2027, netOwing: owing('16610', '8400', '-47.35') });
  assert.equal(got.required, true);
  assert.equal(got.instalments.length, 4);
  assert.equal(got.instalments[0].dueOn, '2027-03-15');
});

test('under the threshold in the current year → not required, whatever the prior years', () => {
  // The first conjunct. A year where you owe little requires nothing even after two
  // large years.
  const got = instalmentObligation({ year: 2027, netOwing: owing('2999.99', '50000', '50000') });
  assert.equal(got.required, false);
  assert.match(got.reason, /current year/i);
});

test('exactly at the threshold is not over it', () => {
  // CRA says "more than $3,000", so $3,000 exactly requires nothing. An off-by-one
  // here is the difference between a warning and a false alarm.
  const got = instalmentObligation({ year: 2027, netOwing: owing('3000', '50000', '50000') });
  assert.equal(got.required, false);
});

test('either prior year satisfies the second conjunct — the two-years-prior one counts', () => {
  // "Either of the two preceding years", not "the immediately preceding year". A
  // single quiet year in between does not clear the obligation.
  const got = instalmentObligation({ year: 2027, netOwing: owing('10000', '0', '9000') });
  assert.equal(got.required, true);
});

test('the immediately prior year alone satisfies it', () => {
  const got = instalmentObligation({ year: 2027, netOwing: owing('10000', '9000', '0') });
  assert.equal(got.required, true);
});

test('a negative net owing is a refund, not an obligation', () => {
  const got = instalmentObligation({ year: 2027, netOwing: owing('-500', '50000', '50000') });
  assert.equal(got.required, false);
});

// ---------------------------------------------------------------------------
// The three CRA calculation options
// ---------------------------------------------------------------------------

test('the prior-year option is the prior year split four ways', () => {
  const got = instalmentObligation({ year: 2027, netOwing: owing('16610', '8400', '4000') });
  const prior = got.options.find((o) => o.basis === 'prior_year');
  assert.ok(prior);
  assert.equal(prior.total.toFixed(2), '8400.00');
  assert.deepEqual(prior.instalments.map((i) => i.amount.toFixed(2)), ['2100.00', '2100.00', '2100.00', '2100.00']);
  assert.equal(prior.carriesInterestRisk, false);
});

test('the current-year option is this year\'s estimate split four ways, and is flagged', () => {
  // The only option that can leave you short: underestimate and CRA charges interest
  // on the shortfall. Picking it for him would hide that.
  const got = instalmentObligation({ year: 2027, netOwing: owing('16610', '8400', '4000') });
  const current = got.options.find((o) => o.basis === 'current_year');
  assert.ok(current);
  assert.equal(current.total.toFixed(2), '16610.00');
  assert.equal(current.carriesInterestRisk, true);
});

test('the no-calculation option front-loads the second prior year, then the remainder', () => {
  // CRA's reminder amount: 1/4 of the SECOND prior year on Mar 15 and Jun 15, then
  // the prior year's remainder split over Sep 15 and Dec 15.
  //   two years prior 4,000 → 1,000 each in March and June
  //   prior year 8,400 less 2,000 already scheduled = 6,400 → 3,200 each in Sep, Dec
  const got = instalmentObligation({ year: 2027, netOwing: owing('16610', '8400', '4000') });
  const nc = got.options.find((o) => o.basis === 'no_calculation');
  assert.ok(nc);
  assert.deepEqual(
    nc.instalments.map((i) => i.amount.toFixed(2)),
    ['1000.00', '1000.00', '3200.00', '3200.00'],
  );
  assert.equal(nc.total.toFixed(2), '8400.00', 'the option totals the prior year');
  assert.equal(nc.carriesInterestRisk, false);
});

test('no-calculation never schedules a negative when the prior year is the smaller', () => {
  // Two years prior 20,000, prior year 4,000: a quarter of 20,000 twice already
  // exceeds the prior year, so the remainder would go negative. CRA's own reminder
  // never asks for money back — it floors at zero.
  const nc = noCalculationInstalments(D('4000'), D('20000'), 2027);
  assert.deepEqual(nc.map((i) => i.amount.toFixed(2)), ['5000.00', '5000.00', '0.00', '0.00']);
});

test('the recommended option is the prior year in a rising-income year', () => {
  // Safe: pay what last year proved, owe the rest in April with no interest.
  const got = instalmentObligation({ year: 2027, netOwing: owing('16610', '8400', '4000') });
  assert.equal(got.recommended, 'prior_year');
});

test('all four CRA due dates survive, on the 15th', () => {
  const got = quarterlyInstalments(D('12000'), 2027);
  assert.deepEqual(
    got.map((i) => i.dueOn),
    ['2027-03-15', '2027-06-15', '2027-09-15', '2027-12-15'],
  );
});

test('the balance-due date is named alongside the instalments', () => {
  // The biggest number in the picture. The March instalment is first in time, but the
  // April payment of the 2026 balance is the larger obligation and nothing named it.
  const got = instalmentObligation({ year: 2027, netOwing: owing('16610', '8400', '4000') });
  assert.equal(got.balanceDueOn, '2028-04-30');
});

test('a year that requires nothing still reports the balance-due date', () => {
  // 2026 owes no instalments and still owes its balance by 2027-04-30.
  const got = instalmentObligation({ year: 2026, netOwing: owing('8400', '-47.35', '0') });
  assert.equal(got.required, false);
  assert.equal(got.balanceDueOn, '2027-04-30');
});
