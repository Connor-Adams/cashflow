/**
 * Year-to-date actuals plus a run-rate projection of the remainder.
 *
 * Deliberately NOT the existing mechanism. `projectPersonalFactsFromPrevYear`
 * scales year N and carries no year-N+1 transactions, which is exactly the defect
 * part 0 demotes: prod scenario 18 was a `projection_root` holding zero 2026 rows,
 * and its CPP of 1,168.96 could only be 2025 T4 income scaled forward. Reusing that
 * here would reintroduce the same wrong number under a new name.
 *
 * The delicate rule is the denominator. A month with NO transactions at all is an
 * unimported month and must be excluded — averaging over it reads a missing
 * statement as a zero-draw month and under-projects exactly when data is missing. A
 * month WITH transactions but no draws is a real zero and must be included —
 * excluding it over-projects, which is the mirror error. Absence of draws cannot
 * distinguish the two cases, so coverage is defined on any transaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { projectRemainder, type MonthlyActivity } from './projectRemainder';

const month = (m: number, txnCount: number, draws: string): MonthlyActivity => ({
  month: m, transactionCount: txnCount, draws: D(draws),
});

/** Jan–Jun each carrying transactions and $10,000 of draws. */
const SIX_EVEN_MONTHS = [1, 2, 3, 4, 5, 6].map((m) => month(m, 12, '10000'));

test('six months at $10,000 projects $120,000 for the year', () => {
  const got = projectRemainder({ months: SIX_EVEN_MONTHS, asOfMonth: 6, year: 2026 });
  assert.equal(got.actualToDate.toFixed(2), '60000.00');
  assert.equal(got.monthlyRunRate.toFixed(2), '10000.00');
  assert.equal(got.projectedRemainder.toFixed(2), '60000.00');
  assert.equal(got.projectedTotal.toFixed(2), '120000.00');
  assert.equal(got.coveredMonths, 6);
});

test('a month with transactions but no draws is a real zero and counts', () => {
  // Five months of $10,000 and one month that posted 8 transactions and no draws is
  // $50,000 over six months, not over five. Excluding it would project $120,000
  // instead of $100,000.
  const months = [
    ...[1, 2, 3, 4, 5].map((m) => month(m, 12, '10000')),
    month(6, 8, '0'),
  ];
  const got = projectRemainder({ months, asOfMonth: 6, year: 2026 });
  assert.equal(got.coveredMonths, 6);
  assert.equal(got.monthlyRunRate.toFixed(2), '8333.33');
  assert.equal(got.projectedTotal.toFixed(2), '100000.00');
});

test('a month with no transactions at all is unimported and excluded', () => {
  // The same $50,000, but June posted nothing whatsoever. Averaging over six months
  // would read a missing statement as a zero-draw month and under-project.
  const months = [
    ...[1, 2, 3, 4, 5].map((m) => month(m, 12, '10000')),
    month(6, 0, '0'),
  ];
  const got = projectRemainder({ months, asOfMonth: 6, year: 2026 });
  assert.equal(got.coveredMonths, 5);
  assert.equal(got.monthlyRunRate.toFixed(2), '10000.00');
  assert.equal(got.uncoveredMonths.length, 1);
  assert.deepEqual(got.uncoveredMonths, [6]);
});

test('an uncovered month is projected, not treated as elapsed and empty', () => {
  // Five covered months at $10,000, June uncovered, asOf June. The projection must
  // cover June through December — seven months — not just July through December.
  const months = [
    ...[1, 2, 3, 4, 5].map((m) => month(m, 12, '10000')),
    month(6, 0, '0'),
  ];
  const got = projectRemainder({ months, asOfMonth: 6, year: 2026 });
  assert.equal(got.actualToDate.toFixed(2), '50000.00');
  assert.equal(got.projectedRemainder.toFixed(2), '70000.00', 'June through December');
  assert.equal(got.projectedTotal.toFixed(2), '120000.00');
});

test('a complete year converges on the actuals with nothing projected', () => {
  const months = Array.from({ length: 12 }, (_, i) => month(i + 1, 12, '10000'));
  const got = projectRemainder({ months, asOfMonth: 12, year: 2026 });
  assert.equal(got.projectedRemainder.toFixed(2), '0.00');
  assert.equal(got.projectedTotal.toFixed(2), '120000.00');
  assert.equal(got.projectedTotal.toFixed(2), got.actualToDate.toFixed(2));
});

test('no covered months at all projects nothing rather than dividing by zero', () => {
  const got = projectRemainder({ months: [], asOfMonth: 6, year: 2026 });
  assert.equal(got.coveredMonths, 0);
  assert.equal(got.monthlyRunRate.toFixed(2), '0.00');
  assert.equal(got.projectedTotal.toFixed(2), '0.00');
  assert.match(got.basis, /no months/i);
});

test('the basis states the assumption in words', () => {
  // Part 0's discipline: a forward number that looks like a filed number is the
  // failure that part exists to prevent, so the projection says what it assumed.
  const got = projectRemainder({ months: SIX_EVEN_MONTHS, asOfMonth: 6, year: 2026 });
  assert.match(got.basis, /6 months/);
  assert.match(got.basis, /10,?000/);
});

test('the basis names the months it could not see', () => {
  const months = [
    ...[1, 2, 3].map((m) => month(m, 12, '10000')),
    month(4, 0, '0'),
    month(5, 0, '0'),
  ];
  const got = projectRemainder({ months, asOfMonth: 5, year: 2026 });
  assert.match(got.basis, /no transactions/i);
  assert.deepEqual(got.uncoveredMonths, [4, 5]);
});

test('months after asOf are not counted as uncovered', () => {
  // December has no transactions in June because December has not happened. Reporting
  // it as an unimported month would be alarming and wrong.
  const got = projectRemainder({ months: SIX_EVEN_MONTHS, asOfMonth: 6, year: 2026 });
  assert.deepEqual(got.uncoveredMonths, []);
});

test('negative draws net against the run rate rather than being dropped', () => {
  // A reversal or a repayment. Dropping it would overstate the rate.
  const months = [month(1, 12, '10000'), month(2, 12, '-2000')];
  const got = projectRemainder({ months, asOfMonth: 2, year: 2026 });
  assert.equal(got.actualToDate.toFixed(2), '8000.00');
  assert.equal(got.monthlyRunRate.toFixed(2), '4000.00');
});
