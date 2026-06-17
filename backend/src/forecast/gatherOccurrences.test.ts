/**
 * DB-backed golden tests for the shared occurrence derivation (#404).
 *
 * Pins the occurrence pipeline both consumers fold into:
 *   - GET /api/forecast calls gatherPlannedOccurrences with NO typeFilter.
 *   - safe-to-spend calls it with typeFilter='expense'.
 * Plus the pure currency tiebreak. These golden counts/sums are the
 * regression lock for the #404 dedup: they must not move when the forecast
 * route and safeToSpend.ts switch from their inline copies to this module.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account, Household, User } from '../models';
import { PlannedEvent } from '../models/PlannedEvent';
import {
  gatherPlannedOccurrences,
  pickCurrencyByLargestAbsBalance,
} from './gatherOccurrences';

let HH = 0;
let USER = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const user = await User.create({
    email: 'gather@example.com',
    displayName: 'Gather',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  const household = await Household.create({ name: 'Gather household' } as never);
  HH = household.id;
  USER = user.id;
});

function planned(over: Partial<Parameters<typeof PlannedEvent.create>[0]> = {}) {
  return PlannedEvent.create({
    userId: USER,
    householdId: HH,
    accountId: null,
    type: 'expense',
    name: 'Rent',
    amount: '1000.0000',
    currency: 'CAD',
    expectedDate: '2026-06-15',
    recurrenceRule: null,
    linkedTransactionId: null,
    notes: null,
    cadence: null,
    normalizedName: null,
    lastChargeDate: null,
    nextExpectedDate: null,
    annualizedCost: null,
    cancellationUrl: null,
    category: null,
    ...over,
  } as never);
}

test('gather: one-off expense yields a single occurrence in window', async () => {
  await planned();
  const occ = await gatherPlannedOccurrences({
    householdId: HH,
    currency: 'CAD',
    from: '2026-06-01',
    to: '2026-07-01',
  });
  assert.equal(occ.length, 1);
  assert.equal(occ[0].date, '2026-06-15');
  assert.equal(Number(occ[0].row.amount), 1000);
});

test('gather: weekly subscription expands across the inclusive window', async () => {
  await planned({
    name: 'Meal kit',
    kind: 'subscription',
    cadence: 'weekly',
    normalizedName: 'meal kit',
    amount: '50.0000',
    expectedDate: '2026-05-01',
    nextExpectedDate: '2026-06-05',
  });
  // 06-05/12/19/26 inside [06-01, 06-30] → 4 occurrences.
  const occ = await gatherPlannedOccurrences({
    householdId: HH,
    currency: 'CAD',
    from: '2026-06-01',
    to: '2026-06-30',
  });
  assert.deepEqual(
    occ.map((o) => o.date),
    ['2026-06-05', '2026-06-12', '2026-06-19', '2026-06-26'],
  );
});

test('gather: typeFilter=expense excludes income rows', async () => {
  await planned(); // expense
  await planned({ name: 'Paycheck', type: 'income', amount: '3000.0000' });
  const withFilter = await gatherPlannedOccurrences({
    householdId: HH,
    currency: 'CAD',
    from: '2026-06-01',
    to: '2026-07-01',
    typeFilter: 'expense',
  });
  const noFilter = await gatherPlannedOccurrences({
    householdId: HH,
    currency: 'CAD',
    from: '2026-06-01',
    to: '2026-07-01',
  });
  assert.equal(withFilter.length, 1);
  assert.equal(withFilter[0].row.type, 'expense');
  assert.equal(noFilter.length, 2);
});

test('gather: excludes cancelled rows and other currencies', async () => {
  await planned({ status: 'cancelled' });
  await planned({ currency: 'USD' });
  const occ = await gatherPlannedOccurrences({
    householdId: HH,
    currency: 'CAD',
    from: '2026-06-01',
    to: '2026-07-01',
  });
  assert.equal(occ.length, 0);
});

test('gather: accountId scopes to a single account', async () => {
  const mkAccount = (name: string) =>
    Account.create({
      name,
      householdId: HH,
      ownerUserId: USER,
      owner: 'connor',
      visibility: 'household',
      accountType: 'chequing',
      defaultCurrency: 'CAD',
      openingBalance: '0.0000',
    } as never);
  const a = await mkAccount('A');
  const b = await mkAccount('B');
  await planned({ accountId: a.id });
  await planned({ accountId: b.id });
  const occ = await gatherPlannedOccurrences({
    householdId: HH,
    currency: 'CAD',
    from: '2026-06-01',
    to: '2026-07-01',
    accountId: a.id,
  });
  assert.equal(occ.length, 1);
  assert.equal(occ[0].row.accountId, a.id);
});

test('pickCurrencyByLargestAbsBalance: largest absolute wins', () => {
  const m = new Map<string, number>([
    ['CAD', 100],
    ['USD', -500],
  ]);
  assert.equal(pickCurrencyByLargestAbsBalance(m), 'USD');
});

test('pickCurrencyByLargestAbsBalance: CAD wins ties', () => {
  const m = new Map<string, number>([
    ['USD', 200],
    ['CAD', 200],
  ]);
  assert.equal(pickCurrencyByLargestAbsBalance(m), 'CAD');
});

test('pickCurrencyByLargestAbsBalance: empty map → null', () => {
  assert.equal(pickCurrencyByLargestAbsBalance(new Map()), null);
});

test('pickCurrencyByLargestAbsBalance: order-preserving across unit scale', () => {
  const dollars = new Map<string, number>([
    ['CAD', 100],
    ['USD', 250],
  ]);
  const cents = new Map<string, number>([
    ['CAD', 100 * 10000],
    ['USD', 250 * 10000],
  ]);
  assert.equal(
    pickCurrencyByLargestAbsBalance(dollars),
    pickCurrencyByLargestAbsBalance(cents),
  );
});
