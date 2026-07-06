/**
 * DB-backed unit tests for `getUpcomingRequiredExpenses` (safe-to-spend).
 *
 * Pins that the upcoming-required-expenses window counts BOTH ordinary
 * planned events and subscription-kind expectations. Subscriptions carry a
 * `cadence` + `nextExpectedDate` instead of a recurrenceRule — the same
 * fold that routes/forecast.ts already handles; excluding them here made
 * safe-to-spend overstate spendable cash by every tracked subscription.
 *
 * Pure compose math lives in cashflowSafeToSpendCompose.test.ts; the full
 * HTTP path in test/integration/cashflowSafeToSpend.test.ts.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sequelize } from '../db';
import { Household, User, Account, Transaction } from '../models';
import { PlannedEvent } from '../models/PlannedEvent';
import { getUpcomingRequiredExpenses } from './safeToSpend';

let HH = 0;
let USER = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const user = await User.create({
    email: 'sts@example.com',
    displayName: 'STS',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  const household = await Household.create({ name: 'STS household' } as never);
  HH = household.id;
  USER = user.id;
});

function basePlanned(over: Partial<Parameters<typeof PlannedEvent.create>[0]> = {}) {
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

/** Create an account of the given type; returns its id. */
async function mkAccount(name: string, accountType: string): Promise<number> {
  const acc = await Account.create({
    name,
    householdId: HH,
    ownerUserId: USER,
    owner: 'me',
    visibility: 'household',
    accountType,
    defaultCurrency: 'CAD',
    openingBalance: '0.0000',
  } as never);
  return acc.id;
}

/** Seed a single charge (negative amount) on an account for a given merchant. */
async function mkCharge(
  accountId: number,
  date: string,
  amount: number,
  merchant: string,
): Promise<void> {
  await Transaction.create({
    accountId,
    householdId: HH,
    visibility: 'household',
    ownershipType: 'me',
    importBatch: 'sts-cardfund-test',
    date,
    merchantRaw: merchant,
    merchantClean: merchant,
    amount: amount.toFixed(4),
    currency: 'CAD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  } as never);
}

test('counts an ordinary one-off planned expense inside the window', async () => {
  await basePlanned();
  const total = await getUpcomingRequiredExpenses(HH, 'CAD', '2026-06-01', '2026-07-01');
  assert.equal(total, 1000);
});

test('counts a tracked monthly subscription (kind=subscription, cadence, no rule)', async () => {
  // $400/mo of bills tracked as a subscription expectation: one charge falls
  // in the 30-day window, so it must reduce safe-to-spend by 400.
  await basePlanned({
    name: 'Hydro + Internet',
    kind: 'subscription',
    cadence: 'monthly',
    normalizedName: 'hydro + internet',
    amount: '400.0000',
    expectedDate: '2026-03-15',
    nextExpectedDate: '2026-06-15',
  });
  const total = await getUpcomingRequiredExpenses(HH, 'CAD', '2026-06-01', '2026-07-01');
  assert.equal(total, 400);
});

test('expands a weekly subscription across the window from nextExpectedDate', async () => {
  await basePlanned({
    name: 'Meal kit',
    kind: 'subscription',
    cadence: 'weekly',
    normalizedName: 'meal kit',
    amount: '50.0000',
    expectedDate: '2026-05-01',
    nextExpectedDate: '2026-06-05',
  });
  // 2026-06-05/12/19/26 → 4 occurrences inside [2026-06-01, 2026-06-30].
  const total = await getUpcomingRequiredExpenses(HH, 'CAD', '2026-06-01', '2026-06-30');
  assert.equal(total, 200);
});

test('sums subscriptions and planned events together', async () => {
  await basePlanned();
  await basePlanned({
    name: 'Streaming',
    kind: 'subscription',
    cadence: 'monthly',
    normalizedName: 'streaming',
    amount: '20.0000',
    expectedDate: '2026-04-10',
    nextExpectedDate: '2026-06-10',
  });
  const total = await getUpcomingRequiredExpenses(HH, 'CAD', '2026-06-01', '2026-07-01');
  assert.equal(total, 1020);
});

test('ignores cancelled subscriptions and other currencies', async () => {
  await basePlanned({
    name: 'Cancelled box',
    kind: 'subscription',
    cadence: 'monthly',
    normalizedName: 'cancelled box',
    amount: '30.0000',
    status: 'cancelled',
    expectedDate: '2026-06-10',
    nextExpectedDate: '2026-06-10',
  });
  await basePlanned({
    name: 'USD sub',
    kind: 'subscription',
    cadence: 'monthly',
    normalizedName: 'usd sub',
    amount: '25.0000',
    currency: 'USD',
    expectedDate: '2026-06-12',
    nextExpectedDate: '2026-06-12',
  });
  const total = await getUpcomingRequiredExpenses(HH, 'CAD', '2026-06-01', '2026-07-01');
  assert.equal(total, 0);
});

test('excludes a card-funded subscription (its spend is reserved by the CC-payment leg)', async () => {
  // Spotify is charged to a credit card, so it rolls into the card balance the
  // expected-credit-card-payment leg already reserves. Counting the projected
  // occurrence here too would double-reserve the same recurring charge.
  const cardId = await mkAccount('Amex', 'credit_card');
  await mkCharge(cardId, '2026-05-14', -20, 'Spotify');
  await basePlanned({
    name: 'Spotify',
    kind: 'subscription',
    cadence: 'monthly',
    normalizedName: 'spotify',
    amount: '20.0000',
    expectedDate: '2026-04-10',
    nextExpectedDate: '2026-06-10',
  });
  const total = await getUpcomingRequiredExpenses(HH, 'CAD', '2026-06-01', '2026-07-01');
  assert.equal(total, 0);
});

test('still counts a bank-funded subscription even when the household has cards', async () => {
  // A card exists (with an unrelated charge), but the Gym membership is charged
  // to a chequing account — a real in-window cash outflow the CC leg never sees.
  const cardId = await mkAccount('Amex', 'credit_card');
  await mkCharge(cardId, '2026-05-14', -20, 'Spotify');
  const bankId = await mkAccount('Chequing', 'chequing');
  await mkCharge(bankId, '2026-05-14', -50, 'Gym');
  await basePlanned({
    name: 'Gym',
    kind: 'subscription',
    cadence: 'monthly',
    normalizedName: 'gym',
    amount: '50.0000',
    expectedDate: '2026-04-10',
    nextExpectedDate: '2026-06-10',
  });
  const total = await getUpcomingRequiredExpenses(HH, 'CAD', '2026-06-01', '2026-07-01');
  assert.equal(total, 50);
});

test('ordinary planned expenses are never dropped by the card-funded filter', async () => {
  // Same merchant name on a card, but the row is kind=planned (a real bill),
  // not a detected subscription — it must still count.
  const cardId = await mkAccount('Amex', 'credit_card');
  await mkCharge(cardId, '2026-05-14', -1000, 'Rent');
  await basePlanned({ name: 'Rent', normalizedName: 'rent' });
  const total = await getUpcomingRequiredExpenses(HH, 'CAD', '2026-06-01', '2026-07-01');
  assert.equal(total, 1000);
});
