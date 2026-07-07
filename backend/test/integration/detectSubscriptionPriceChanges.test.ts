/**
 * Integration test for the subscription price-increase detector (Task 3 of the
 * subscription-price-increase-observation plan).
 *
 * This is the DB-level / end-to-end half of the detector test. It lives in the
 * Postgres integration suite (not the SQLite unit suite) because the detector
 * filters `Transaction.merchantClean` with `Op.iLike`, which Sequelize emits as
 * raw `ILIKE` — unsupported by SQLite (`SQLITE_ERROR: near "ILIKE"`). The
 * dialect-independent threshold/median math is unit-tested in
 * `test/detectSubscriptionPriceChanges.test.ts`.
 *
 * Verifies the two contract cases: a >=5% increase vs the 90-day median emits
 * exactly one `subscription_price_increase` Insight (entityType='expectation',
 * entityId=PlannedEvent.id, metadata.newAmountCents/previousAmountCents in
 * positive cents); a price drop emits none.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let models: typeof import('../../src/models');
let detect: typeof import('../../src/subscriptions/detectSubscriptionPriceChanges').detectSubscriptionPriceChanges;

before(async () => {
  testDb = await setupPgTestDb('subscription-price-detect');
  models = await import('../../src/models');
  ({ detectSubscriptionPriceChanges: detect } = await import(
    '../../src/subscriptions/detectSubscriptionPriceChanges'
  ));
});

after(async () => {
  await teardownPgTestDb(testDb);
});

beforeEach(async () => {
  await models.Insight.destroy({ where: {} });
  await models.Transaction.destroy({ where: {} });
  await models.PlannedEvent.destroy({ where: {} });
  await models.Account.destroy({ where: {} });
  await models.HouseholdMember.destroy({ where: {} });
  await models.Household.destroy({ where: {} });
  await models.User.destroy({ where: {} });
});

async function seedHousehold(): Promise<{ householdId: number; userId: number; accountId: number }> {
  const user = await models.User.create({
    email: `spc-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: 'SPC user',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  });
  const household = await models.Household.create({ name: 'SPC household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: 'SPC card',
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: 'SPC',
  });
  return { householdId: household.id, userId: user.id, accountId: account.id };
}

async function seedSub(householdId: number, userId: number, merchant: string): Promise<number> {
  const row = await models.PlannedEvent.create({
    kind: 'subscription',
    type: 'expense',
    source: 'recurring_detection',
    userId,
    householdId,
    name: merchant,
    normalizedName: merchant.toLowerCase(),
    amount: '20.0000',
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate: daysAgo(20),
    nextExpectedDate: null,
    expectedDate: daysAgo(20),
    annualizedCost: '240.0000',
    status: 'planned',
    statusUncertain: false,
    category: null,
    cancellationUrl: null,
    notes: null,
  });
  return row.id;
}

/**
 * The detector's baseline window is 90 days ending at the real `Date.now()`
 * (detectSubscriptionPriceChanges.ts), so fixed calendar dates silently rot out
 * of range as the wall clock advances — a charge seeded at a hardcoded date
 * eventually falls outside the window and the baseline collapses. Seed relative
 * to today instead; offsets sit comfortably inside 90 days and preserve each
 * test's ordering (older baseline charges first, most-recent charge last).
 */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

let fpCounter = 0;
async function seedTxn(
  householdId: number,
  accountId: number,
  merchant: string,
  amount: string,
  date: string,
): Promise<void> {
  fpCounter += 1;
  const fp = `spc-${accountId}-${date}-${amount}-${fpCounter}-${Math.random()}`;
  await models.Transaction.create({
    householdId,
    accountId,
    date,
    amount,
    currency: 'CAD',
    merchantRaw: merchant,
    merchantClean: merchant,
    finalCategory: 'Streaming',
    visibility: 'shared',
    importBatch: 'test',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
  } as never);
}

test('emits a subscription_price_increase Insight on a >=5% increase vs 90d median', async () => {
  const { householdId, userId, accountId } = await seedHousehold();
  const subId = await seedSub(householdId, userId, 'Netflix');
  await seedTxn(householdId, accountId, 'Netflix', '-10.00', daysAgo(60));
  await seedTxn(householdId, accountId, 'Netflix', '-10.00', daysAgo(35));
  await seedTxn(householdId, accountId, 'Netflix', '-11.00', daysAgo(10)); // +10% vs median 10
  const r = await detect();
  assert.equal(r.detected, 1);
  const ins = await models.Insight.findOne({ where: { type: 'subscription_price_increase' } });
  assert.ok(ins);
  assert.equal(ins!.entityType, 'expectation');
  assert.equal(ins!.entityId, subId);
  assert.equal(ins!.status, 'open');
  const md = ins!.metadata as { newAmountCents: number; previousAmountCents: number; pctChange: number };
  assert.equal(md.newAmountCents, 1100);
  assert.equal(md.previousAmountCents, 1000);
  assert.equal(md.pctChange, 10);
});

test('does NOT emit on a price DROP', async () => {
  const { householdId, userId, accountId } = await seedHousehold();
  await seedSub(householdId, userId, 'Spotify');
  await seedTxn(householdId, accountId, 'Spotify', '-10.00', daysAgo(60));
  await seedTxn(householdId, accountId, 'Spotify', '-10.00', daysAgo(35));
  await seedTxn(householdId, accountId, 'Spotify', '-8.00', daysAgo(10)); // -20%
  const r = await detect();
  assert.equal(r.detected, 0);
  assert.equal(await models.Insight.count(), 0);
});

test('upserts (does not duplicate or reopen) on a re-run with the same increase', async () => {
  const { householdId, userId, accountId } = await seedHousehold();
  await seedSub(householdId, userId, 'Netflix');
  await seedTxn(householdId, accountId, 'Netflix', '-10.00', daysAgo(60));
  await seedTxn(householdId, accountId, 'Netflix', '-10.00', daysAgo(35));
  await seedTxn(householdId, accountId, 'Netflix', '-11.00', daysAgo(10));
  await detect();
  const ins = await models.Insight.findOne({ where: { type: 'subscription_price_increase' } });
  await ins!.update({ status: 'dismissed' });
  // Re-run: same fingerprint => refresh, must NOT reopen and must NOT duplicate.
  const r2 = await detect();
  assert.equal(r2.detected, 1); // detector still "detects"; upsert refreshes
  assert.equal(await models.Insight.count({ where: { type: 'subscription_price_increase' } }), 1);
  const after = await models.Insight.findOne({ where: { type: 'subscription_price_increase' } });
  assert.equal(after!.status, 'dismissed');
});

test('does NOT emit when the most recent matching row is a refund/credit', async () => {
  // A positive refund (e.g. a two-month credit) must not be read as the
  // latest charge — Math.abs would turn it into a fake +100% price hike.
  const { householdId, userId, accountId } = await seedHousehold();
  await seedSub(householdId, userId, 'Crave');
  await seedTxn(householdId, accountId, 'Crave', '-9.99', daysAgo(60));
  await seedTxn(householdId, accountId, 'Crave', '-9.99', daysAgo(35));
  await seedTxn(householdId, accountId, 'Crave', '19.98', daysAgo(10)); // refund, most recent
  const r = await detect();
  assert.equal(r.detected, 0);
  assert.equal(await models.Insight.count(), 0);
});

test('refunds inside the 90-day window do not pollute the median baseline', async () => {
  // Charges $10 → $11 (+10%) with a small unrelated credit in between. The
  // baseline must stay at the $10 charge median, not the charge/credit mix.
  const { householdId, userId, accountId } = await seedHousehold();
  await seedSub(householdId, userId, 'Disney');
  await seedTxn(householdId, accountId, 'Disney', '-10.00', daysAgo(60));
  await seedTxn(householdId, accountId, 'Disney', '1.00', daysAgo(35)); // credit
  await seedTxn(householdId, accountId, 'Disney', '-11.00', daysAgo(10));
  const r = await detect();
  assert.equal(r.detected, 1);
  const ins = await models.Insight.findOne({ where: { type: 'subscription_price_increase' } });
  assert.ok(ins);
  const md = ins!.metadata as { newAmountCents: number; previousAmountCents: number };
  assert.equal(md.newAmountCents, 1100);
  assert.equal(md.previousAmountCents, 1000);
});
