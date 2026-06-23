/**
 * Pure tests for recurring-income detection + window projection.
 *
 * Safe-to-spend was pessimistic: it subtracted future required outflows but
 * never added the income that lands in the same window. `detectRecurringIncome`
 * finds high-confidence recurring inflows (paychecks) from transaction history;
 * `projectRecurringIncome` sums the occurrences that fall inside the window.
 *
 * Detection is deliberately CONSERVATIVE — over-counting income inflates
 * safe-to-spend (tells the user they can spend money they don't have), which is
 * the dangerous direction. Require >= 3 regular occurrences, consistent amounts,
 * and a still-active stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRecurringIncome,
  projectRecurringIncome,
  type IncomeTxn,
} from './recurringIncome';

const ASOF = '2026-06-20';

function paycheck(dates: string[], amount: number, merchant = 'ACME PAYROLL'): IncomeTxn[] {
  return dates.map((date) => ({ date, amount, merchant }));
}

// --- detection ------------------------------------------------------------

test('detects a clean biweekly paycheck stream', () => {
  const txns = paycheck(
    ['2026-04-24', '2026-05-08', '2026-05-22', '2026-06-05', '2026-06-19'],
    2500,
  );
  const streams = detectRecurringIncome(txns, ASOF);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].amount, 2500);
  assert.equal(streams[0].cadenceDays, 14);
  assert.equal(streams[0].lastDate, '2026-06-19');
});

test('rejects a stream with fewer than 3 occurrences', () => {
  const txns = paycheck(['2026-06-05', '2026-06-19'], 2500);
  assert.equal(detectRecurringIncome(txns, ASOF).length, 0);
});

test('rejects irregular spacing (not a real cadence)', () => {
  const txns = paycheck(['2026-03-01', '2026-04-02', '2026-06-19'], 2500);
  assert.equal(detectRecurringIncome(txns, ASOF).length, 0);
});

test('rejects wildly varying amounts (not a stable paycheck)', () => {
  const txns: IncomeTxn[] = [
    { date: '2026-05-06', amount: 500, merchant: 'GIG' },
    { date: '2026-05-20', amount: 3000, merchant: 'GIG' },
    { date: '2026-06-03', amount: 800, merchant: 'GIG' },
    { date: '2026-06-17', amount: 4200, merchant: 'GIG' },
  ];
  assert.equal(detectRecurringIncome(txns, ASOF).length, 0);
});

test('drops a stale stream whose last occurrence is long past', () => {
  const txns = paycheck(
    ['2025-10-03', '2025-10-17', '2025-10-31', '2025-11-14'],
    2500,
  );
  assert.equal(detectRecurringIncome(txns, ASOF).length, 0);
});

test('uses the median amount when paychecks vary slightly', () => {
  const txns: IncomeTxn[] = [
    { date: '2026-04-24', amount: 2480, merchant: 'ACME' },
    { date: '2026-05-08', amount: 2500, merchant: 'ACME' },
    { date: '2026-05-22', amount: 2510, merchant: 'ACME' },
    { date: '2026-06-05', amount: 2500, merchant: 'ACME' },
    { date: '2026-06-19', amount: 2495, merchant: 'ACME' },
  ];
  const streams = detectRecurringIncome(txns, ASOF);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].amount, 2500);
});

test('separates two distinct payroll sources', () => {
  const txns = [
    ...paycheck(['2026-04-24', '2026-05-08', '2026-05-22', '2026-06-05', '2026-06-19'], 2500, 'ACME'),
    ...paycheck(['2026-04-15', '2026-05-15', '2026-06-15'], 1200, 'SIDE GIG'),
  ];
  const streams = detectRecurringIncome(txns, ASOF);
  assert.equal(streams.length, 2);
});

// --- projection -----------------------------------------------------------

test('projects one biweekly occurrence landing inside the window', () => {
  const streams = [
    { merchant: 'ACME', amount: 2500, cadenceDays: 14, lastDate: '2026-06-19' },
  ];
  // window [06-20, 07-04]: next occurrence 07-03 is inside, 07-17 is not.
  const total = projectRecurringIncome(streams, '2026-06-20', '2026-07-04');
  assert.equal(total, 2500);
});

test('projects nothing when the next occurrence is past the window end', () => {
  const streams = [
    { merchant: 'RENTAL', amount: 1800, cadenceDays: 30, lastDate: '2026-06-18' },
  ];
  // next from 06-18 + 30 = 07-18, past the 07-04 window end.
  assert.equal(projectRecurringIncome(streams, '2026-06-20', '2026-07-04'), 0);
});

test('projects two occurrences when a weekly stream lands twice in the window', () => {
  const streams = [
    { merchant: 'TIPS', amount: 300, cadenceDays: 7, lastDate: '2026-06-19' },
  ];
  // window [06-20, 07-04]: 06-26 and 07-03 land -> 2 x 300.
  assert.equal(projectRecurringIncome(streams, '2026-06-20', '2026-07-04'), 600);
});
