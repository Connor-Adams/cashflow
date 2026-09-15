import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateWindowInterest, accrueSinceLastWindow } from './interestAllocation';

const w = (
  id: number,
  fromDate: string,
  toDate: string,
  effectiveRate: string,
  applicableInterest: string,
) => ({ id, fromDate, toDate, effectiveRate, applicableInterest });

const loan = (contactId: number, date: string, amount: number) => ({
  contactId,
  date,
  amount,
  currency: 'CAD',
  counterpartyRole: 'loan' as string | null,
  loanDefault: false,
});

test('a window entirely before any loan allocates nothing', () => {
  assert.deepEqual(
    allocateWindowInterest(
      [w(1, '2025-07-08', '2025-08-04', '9.4400', '41.3800')],
      [loan(4, '2026-04-15', -6700)],
      'CAD',
    ),
    [],
  );
});

test('one borrower for a whole window earns balance x rate x days / 365', () => {
  // 2026-08-04..2026-09-03 inclusive is 31 days.
  // 6700 x 8.94% x 31/365 = 50.87227...
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-04-15', -6700)],
    'CAD',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].contactId, 4);
  assert.equal(out[0].rateWindowId, 9);
  assert.equal(out[0].currency, 'CAD');
  assert.equal(Number(out[0].amount).toFixed(2), '50.87');
});

test('a loan made mid-window earns only its remaining days', () => {
  // window 2026-04-07..2026-05-04 is 28 days; loan lands 2026-04-15, so 20 days
  // remain (Apr 15..Apr 30 = 16, May 1..4 = 4). 6700 x 8.94% x 20/365 = 32.82082...
  const out = allocateWindowInterest(
    [w(12, '2026-04-07', '2026-05-04', '8.9400', '79.1900')],
    [loan(4, '2026-04-15', -6700)],
    'CAD',
  );
  assert.equal(Number(out[0].amount).toFixed(2), '32.82');
});

test('the endpoints of a window are both inclusive', () => {
  // A loan landing on the very last day of the window earns exactly one day.
  // 6700 x 8.94% x 1/365 = 1.64104...
  const last = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-09-03', -6700)],
    'CAD',
  );
  assert.equal(Number(last[0].amount).toFixed(2), '1.64');

  // A loan landing the day after the window ends earns nothing.
  assert.deepEqual(
    allocateWindowInterest(
      [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
      [loan(4, '2026-09-04', -6700)],
      'CAD',
    ),
    [],
  );

  // A loan landing on the first day earns the whole 31 days.
  const first = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-08-04', -6700)],
    'CAD',
  );
  assert.equal(Number(first[0].amount).toFixed(2), '50.87');
});

test('two borrowers each earn on their own balance, not a split of the charge', () => {
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-01-01', -6700), loan(1, '2026-01-01', -24275)],
    'CAD',
  );
  const by = Object.fromEntries(out.map((a) => [a.contactId, Number(a.amount)]));
  // CORRECTED from the brief, which pinned 50.87 / 184.27 here. Two problems
  // with that: 184.27 is arithmetically wrong (24275 x 8.94% x 31/365 =
  // 184.31708, i.e. 184.32), and more importantly the raw pair sums to 235.19,
  // which exceeds this window's printed 172.36 — so the bound in the very next
  // test scales BOTH figures down and neither raw number can survive here.
  // What this test can honestly pin on these inputs is the *ratio*: it tracks
  // the balances (24275/6700 = 3.62313) rather than being an even split of the
  // charge. The raw per-balance figures are pinned by the next test, on a
  // window whose printed interest does not bind.
  assert.ok(
    Math.abs(by[1] / by[4] - 24275 / 6700) < 0.001,
    `ratio ${by[1] / by[4]} should track the balance ratio ${24275 / 6700}`,
  );
  assert.notEqual(by[1].toFixed(2), by[4].toFixed(2));
});

test('each borrower earns its own balance x rate x days when the bound does not bind', () => {
  // Same two borrowers and the same 31-day 8.94% window, but with a printed
  // applicable interest high enough that no scaling occurs, so the raw
  // per-balance accruals show through:
  //   6700  x 8.94% x 31/365 =  50.87227 ->  50.87
  //   24275 x 8.94% x 31/365 = 184.31708 -> 184.32
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '500.0000')],
    [loan(4, '2026-01-01', -6700), loan(1, '2026-01-01', -24275)],
    'CAD',
  );
  const by = Object.fromEntries(out.map((a) => [a.contactId, Number(a.amount)]));
  assert.equal(by[4].toFixed(2), '50.87');
  assert.equal(by[1].toFixed(2), '184.32');
});

test("allocations are scaled down so they never exceed the window's printed interest", () => {
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-01-01', -6700), loan(1, '2026-01-01', -24275)],
    'CAD',
  );
  const total = out.reduce((n, a) => n + Number(a.amount), 0);
  assert.ok(total <= 172.36 + 0.0001, `allocated ${total} exceeds the printed 172.36`);
  assert.equal(total.toFixed(2), '172.36', 'scaled to exactly the printed figure');
});

test('a repayment before the window reduces the balance that earns', () => {
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-04-15', -6700), { ...loan(4, '2026-05-01', 3700), counterpartyRole: 'repayment' }],
    'CAD',
  );
  // 3000 x 8.94% x 31/365 = 22.77864...
  assert.equal(Number(out[0].amount).toFixed(2), '22.78');
});

test('a repayment mid-window only reduces the balance from its own date on', () => {
  // 6700 for Aug 4..Aug 14 (11 days), then 3000 for Aug 15..Sep 3 (20 days).
  // 6700 x 8.94% x 11/365 = 18.05128
  // 3000 x 8.94% x 20/365 = 14.69589
  //                        = 32.74717 -> 32.75
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-04-15', -6700), { ...loan(4, '2026-08-15', 3700), counterpartyRole: 'repayment' }],
    'CAD',
  );
  assert.equal(Number(out[0].amount).toFixed(2), '32.75');
});

test('a non-debt role never earns interest', () => {
  assert.deepEqual(
    allocateWindowInterest(
      [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
      [{ ...loan(4, '2026-04-15', -6700), counterpartyRole: 'purchase' }],
      'CAD',
    ),
    [],
  );
});

test('a negative balance earns nothing', () => {
  assert.deepEqual(
    allocateWindowInterest(
      [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
      [{ ...loan(4, '2026-04-15', 500), counterpartyRole: 'repayment' }],
      'CAD',
    ),
    [],
  );
});

test('one contact going negative never subsidises another', () => {
  // Contact 4 is overpaid (you owe them 500); contact 1 holds 24275. Contact 4
  // must contribute zero rather than a negative that inflates contact 1 after
  // scaling. Raw: 24275 x 8.94% x 31/365 = 184.31708, bound 500 does not bind.
  const out = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '500.0000')],
    [{ ...loan(4, '2026-04-15', 500), counterpartyRole: 'repayment' }, loan(1, '2026-01-01', -24275)],
    'CAD',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].contactId, 1);
  assert.equal(Number(out[0].amount).toFixed(2), '184.32');
});

test("the rate in force is the window's own rate, not the latest", () => {
  const out = allocateWindowInterest(
    [w(3, '2025-09-04', '2025-09-17', '9.4400', '26.0400')],
    [loan(1, '2025-01-01', -10000)],
    'CAD',
  );
  // 2025-09-04..2025-09-17 inclusive is 14 days.
  // 10000 x 9.44% x 14/365 = 36.20821 -> scaled down to the printed 26.04
  assert.equal(Number(out[0].amount).toFixed(2), '26.04');
});

test('each window is bounded and rated independently', () => {
  const out = allocateWindowInterest(
    [
      w(3, '2025-09-04', '2025-09-17', '9.4400', '26.0400'),
      w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600'),
    ],
    [loan(1, '2025-01-01', -10000)],
    'CAD',
  );
  assert.equal(out.length, 2);
  // sorted by (rateWindowId, contactId)
  assert.deepEqual(
    out.map((a) => a.rateWindowId),
    [3, 9],
  );
  assert.equal(Number(out[0].amount).toFixed(2), '26.04'); // bound bites
  // 10000 x 8.94% x 31/365 = 75.92877 -> under 172.36, so it does not
  assert.equal(Number(out[1].amount).toFixed(2), '75.93');
});

test('output is sorted by (rateWindowId, contactId)', () => {
  const out = allocateWindowInterest(
    [
      w(9, '2026-08-04', '2026-09-03', '8.9400', '500.0000'),
      w(3, '2026-07-04', '2026-08-03', '8.9400', '500.0000'),
    ],
    [loan(7, '2026-01-01', -1000), loan(2, '2026-01-01', -2000)],
    'CAD',
  );
  assert.deepEqual(
    out.map((a) => [a.rateWindowId, a.contactId]),
    [
      [3, 2],
      [3, 7],
      [9, 2],
      [9, 7],
    ],
  );
});

test('rates arriving as numbers (SQLite) behave identically to strings (Postgres)', () => {
  const asStr = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-01-01', -6700)],
    'CAD',
  );
  const asNum = allocateWindowInterest(
    [
      {
        id: 9,
        fromDate: '2026-08-04',
        toDate: '2026-09-03',
        effectiveRate: 8.94,
        applicableInterest: 172.36,
      },
    ],
    [loan(4, '2026-01-01', -6700)],
    'CAD',
  );
  assert.deepEqual(asStr, asNum);
});

test('row amounts arriving as strings behave identically to numbers', () => {
  const asNum = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-01-01', -6700)],
    'CAD',
  );
  const asStr = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [{ ...loan(4, '2026-01-01', 0), amount: '-6700.00' }],
    'CAD',
  );
  assert.deepEqual(asStr, asNum);
});

test('a different currency is not allocated from a CAD window', () => {
  assert.deepEqual(
    allocateWindowInterest(
      [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
      [{ ...loan(4, '2026-01-01', -6700), currency: 'USD' }],
      'CAD',
    ),
    [],
  );
});

test('a window with zero printed interest allocates nothing', () => {
  assert.deepEqual(
    allocateWindowInterest(
      [w(9, '2026-08-04', '2026-09-03', '8.9400', '0.0000')],
      [loan(4, '2026-01-01', -6700)],
      'CAD',
    ),
    [],
  );
});

test('an untagged row earns only when the contact defaults to lending', () => {
  const off = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [{ ...loan(4, '2026-01-01', -6700), counterpartyRole: null }],
    'CAD',
  );
  assert.deepEqual(off, []);

  const on = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [{ ...loan(4, '2026-01-01', -6700), counterpartyRole: null, loanDefault: true }],
    'CAD',
  );
  assert.equal(Number(on[0].amount).toFixed(2), '50.87');
});

test('re-running over the same inputs is byte-identical', () => {
  const windows = [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')];
  const rows = [loan(4, '2026-01-01', -6700), loan(1, '2026-01-01', -24275)];
  assert.deepEqual(
    allocateWindowInterest(windows, rows, 'CAD'),
    allocateWindowInterest(windows, rows, 'CAD'),
  );
  // and row order must not matter
  assert.deepEqual(
    allocateWindowInterest(windows, rows, 'CAD'),
    allocateWindowInterest(windows, [...rows].reverse(), 'CAD'),
  );
});

// --- accrueSinceLastWindow -------------------------------------------------

test('accrues from the day after lastWindowEnd through asOf inclusive, uncapped', () => {
  // Sep 4..Sep 10 inclusive is 7 days. 6700 x 8.94% x 7/365 = 11.48729 -> 11.49.
  const out = accrueSinceLastWindow({
    lastWindowEnd: '2026-09-03',
    asOf: '2026-09-10',
    currentRate: '8.9400',
    rows: [loan(4, '2026-04-15', -6700)],
    currency: 'CAD',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].contactId, 4);
  assert.equal(out[0].rateWindowId, null);
  assert.equal(out[0].currency, 'CAD');
  assert.equal(Number(out[0].amount).toFixed(2), '11.49');
});

test('asOf equal to lastWindowEnd yields nothing', () => {
  assert.deepEqual(
    accrueSinceLastWindow({
      lastWindowEnd: '2026-09-03',
      asOf: '2026-09-03',
      currentRate: '8.9400',
      rows: [loan(4, '2026-04-15', -6700)],
      currency: 'CAD',
    }),
    [],
  );
});

test('asOf before lastWindowEnd yields nothing (never negative days)', () => {
  assert.deepEqual(
    accrueSinceLastWindow({
      lastWindowEnd: '2026-09-03',
      asOf: '2026-08-15',
      currentRate: '8.9400',
      rows: [loan(4, '2026-04-15', -6700)],
      currency: 'CAD',
    }),
    [],
  );
});

test('the two accrual windows never double-count the statement boundary day', () => {
  // Task 1's window ends 2026-09-03 inclusive (a loan landing on it earns one
  // day there). The tail must start on 2026-09-04, not 2026-09-03, or that day
  // is counted twice across the two figures.
  const charged = allocateWindowInterest(
    [w(9, '2026-08-04', '2026-09-03', '8.9400', '172.3600')],
    [loan(4, '2026-01-01', -6700)],
    'CAD',
  );
  const accrued = accrueSinceLastWindow({
    lastWindowEnd: '2026-09-03',
    asOf: '2026-09-04',
    currentRate: '8.9400',
    rows: [loan(4, '2026-01-01', -6700)],
    currency: 'CAD',
  });
  // Charged covers Aug 4..Sep 3 (31 days); accrued covers exactly Sep 4 (1 day).
  assert.equal(Number(charged[0].amount).toFixed(2), '50.87');
  assert.equal(Number(accrued[0].amount).toFixed(2), '1.64');
});

test('a loan made after lastWindowEnd earns only its remaining days', () => {
  // Tail window is Sep 4..Sep 10 (7 days); the loan lands Sep 6, so only Sep
  // 6..Sep 10 (5 days) earns. 6700 x 8.94% x 5/365 = 8.20521 -> 8.21.
  const out = accrueSinceLastWindow({
    lastWindowEnd: '2026-09-03',
    asOf: '2026-09-10',
    currentRate: '8.9400',
    rows: [loan(4, '2026-09-06', -6700)],
    currency: 'CAD',
  });
  assert.equal(Number(out[0].amount).toFixed(2), '8.21');
});

test('a repayment reduces the earning balance from its own date on', () => {
  // 6700 for Sep 4..Sep 5 (2 days), then 3000 for Sep 6..Sep 10 (5 days).
  // 6700 x 8.94% x 2/365 = 3.28208
  // 3000 x 8.94% x 5/365 = 3.67397
  //                       = 6.95605 -> 6.96
  const out = accrueSinceLastWindow({
    lastWindowEnd: '2026-09-03',
    asOf: '2026-09-10',
    currentRate: '8.9400',
    rows: [loan(4, '2026-04-15', -6700), { ...loan(4, '2026-09-06', 3700), counterpartyRole: 'repayment' }],
    currency: 'CAD',
  });
  assert.equal(Number(out[0].amount).toFixed(2), '6.96');
});

test('a non-debt role never accrues', () => {
  assert.deepEqual(
    accrueSinceLastWindow({
      lastWindowEnd: '2026-09-03',
      asOf: '2026-09-10',
      currentRate: '8.9400',
      rows: [{ ...loan(4, '2026-04-15', -6700), counterpartyRole: 'purchase' }],
      currency: 'CAD',
    }),
    [],
  );
});

test('a negative balance never accrues', () => {
  assert.deepEqual(
    accrueSinceLastWindow({
      lastWindowEnd: '2026-09-03',
      asOf: '2026-09-10',
      currentRate: '8.9400',
      rows: [{ ...loan(4, '2026-04-15', 500), counterpartyRole: 'repayment' }],
      currency: 'CAD',
    }),
    [],
  );
});

test('no upper bound applies: a large balance is not capped', () => {
  // Nothing has been billed for this period, so unlike allocateWindowInterest
  // there is no printed figure to scale down to.
  // 100000 x 8.94% x 7/365 = 171.4521 -> 171.45
  const out = accrueSinceLastWindow({
    lastWindowEnd: '2026-09-03',
    asOf: '2026-09-10',
    currentRate: '8.9400',
    rows: [loan(4, '2026-01-01', -100000)],
    currency: 'CAD',
  });
  assert.equal(Number(out[0].amount).toFixed(2), '171.45');
});

test('accrueSinceLastWindow: rates arriving as numbers (SQLite) behave identically to strings (Postgres)', () => {
  const asStr = accrueSinceLastWindow({
    lastWindowEnd: '2026-09-03',
    asOf: '2026-09-10',
    currentRate: '8.9400',
    rows: [loan(4, '2026-04-15', -6700)],
    currency: 'CAD',
  });
  const asNum = accrueSinceLastWindow({
    lastWindowEnd: '2026-09-03',
    asOf: '2026-09-10',
    currentRate: 8.94,
    rows: [loan(4, '2026-04-15', -6700)],
    currency: 'CAD',
  });
  assert.deepEqual(asStr, asNum);
});

test('accrueSinceLastWindow: a different currency is not accrued', () => {
  assert.deepEqual(
    accrueSinceLastWindow({
      lastWindowEnd: '2026-09-03',
      asOf: '2026-09-10',
      currentRate: '8.9400',
      rows: [{ ...loan(4, '2026-04-15', -6700), currency: 'USD' }],
      currency: 'CAD',
    }),
    [],
  );
});

test('accrueSinceLastWindow: re-running over the same inputs is byte-identical', () => {
  const args = {
    lastWindowEnd: '2026-09-03',
    asOf: '2026-09-10',
    currentRate: '8.9400',
    rows: [loan(4, '2026-01-01', -6700), loan(1, '2026-01-01', -24275)],
    currency: 'CAD',
  };
  assert.deepEqual(accrueSinceLastWindow(args), accrueSinceLastWindow(args));
  assert.deepEqual(
    accrueSinceLastWindow(args),
    accrueSinceLastWindow({ ...args, rows: [...args.rows].reverse() }),
  );
});
