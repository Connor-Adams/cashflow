/**
 * In-memory DB test for the `runDetectorsForHousehold` orchestrator. Verifies
 * the database round-trip: seed transactions / settlements, run detectors,
 * read back persisted rows.
 *
 * Uses sqlite (Node 22 default for unit tests). Integration tests in
 * `test/integration/insights.test.ts` cover route-level behavior against
 * Postgres.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let runDetectorsForHousehold: typeof import('./runDetectors').runDetectorsForHousehold;
let models: typeof import('../models');

before(async () => {
  models = await import('../models');
  sequelize = models.sequelize;
  const m = await import('./runDetectors');
  runDetectorsForHousehold = m.runDetectorsForHousehold;
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  // Reset every table we touch
  await models.Insight.destroy({ where: {}, truncate: true });
  await models.PartnerSettlement.destroy({ where: {}, truncate: true });
  await models.Receipt.destroy({ where: {}, truncate: true });
  await models.PlannedEvent.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Contact.destroy({ where: {}, truncate: true });
  await models.User.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

async function seedHousehold(name: string): Promise<{ householdId: number; accountId: number; userId: number }> {
  const hh = await models.Household.create({ name });
  const user = await models.User.create({
    email: `${name.toLowerCase()}-${crypto.randomBytes(4).toString('hex')}@test.local`,
    displayName: name,
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  });
  const account = await models.Account.create({
    householdId: hh.id,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name: `${name} card`,
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: name.slice(0, 3).toUpperCase(),
  });
  return { householdId: hh.id, accountId: account.id, userId: user.id };
}

async function createTxn(
  householdId: number,
  accountId: number,
  date: string,
  merchant: string,
  amount: number,
  category: string | null = null,
  txnType: string = 'purchase',
): Promise<number> {
  const t = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'runDetectors-test',
    date,
    merchantRaw: merchant,
    merchantClean: merchant,
    amount: amount.toFixed(4),
    currency: 'CAD',
    txnType,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: category,
    autoBusiness: null,
    businessOverride: null,
    autoSplitType: null,
    splitOverride: null,
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });
  return t.id;
}

function isoDaysAgo(now: Date, offset: number): string {
  const d = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

test('runDetectorsForHousehold persists duplicate insights', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId } = await seedHousehold('A');
  await createTxn(householdId, accountId, isoDaysAgo(now, 2), 'Costco', -123.45);
  await createTxn(householdId, accountId, isoDaysAgo(now, 1), 'Costco', -123.45);

  const result = await runDetectorsForHousehold(householdId, { now });
  assert.ok(result.total >= 1);
  const persisted = await models.Insight.findAll({ where: { householdId } });
  const dup = persisted.find((p) => p.type === 'duplicate_transactions');
  assert.ok(dup);
  assert.equal(dup!.status, 'open');
});

test('runDetectorsForHousehold is idempotent (re-running does not duplicate rows)', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId } = await seedHousehold('B');
  await createTxn(householdId, accountId, isoDaysAgo(now, 2), 'Costco', -123.45);
  await createTxn(householdId, accountId, isoDaysAgo(now, 1), 'Costco', -123.45);

  const first = await runDetectorsForHousehold(householdId, { now });
  const second = await runDetectorsForHousehold(householdId, { now });
  const rows = await models.Insight.findAll({ where: { householdId } });
  assert.equal(rows.length, first.total);
  assert.equal(second.created, 0);
  assert.equal(second.refreshed, first.total);
});

test('runDetectorsForHousehold scopes by household_id (no cross-household leakage)', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const a = await seedHousehold('A');
  const b = await seedHousehold('B');
  await createTxn(a.householdId, a.accountId, isoDaysAgo(now, 2), 'Costco', -123.45);
  await createTxn(a.householdId, a.accountId, isoDaysAgo(now, 1), 'Costco', -123.45);

  await runDetectorsForHousehold(a.householdId, { now });
  await runDetectorsForHousehold(b.householdId, { now });
  const aRows = await models.Insight.findAll({ where: { householdId: a.householdId } });
  const bRows = await models.Insight.findAll({ where: { householdId: b.householdId } });
  assert.ok(aRows.length >= 1);
  assert.equal(bRows.length, 0);
});

test('runDetectorsForHousehold ignores money-movement rows (transfers, card payments, investment accounts)', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId } = await seedHousehold('A');
  // Recurring same-amount internal transfers two days apart — not duplicate
  // charges, and not missing-receipt spend either.
  await createTxn(householdId, accountId, isoDaysAgo(now, 12), 'Online transfer sent', -2500, null, 'transfer');
  await createTxn(householdId, accountId, isoDaysAgo(now, 10), 'Online transfer sent', -2500, null, 'transfer');
  // A growing monthly card bill payment — money movement, not a spend spike.
  await createTxn(householdId, accountId, '2026-04-10', 'Amex Bill Pymt', -2000, null, 'payment');
  await createTxn(householdId, accountId, '2026-05-10', 'Amex Bill Pymt', -5000, null, 'payment');
  // A brokerage debit that missed every detectTypeStage pattern (defaults to
  // 'purchase') on an investment account — portfolio churn, not spend.
  const inv = await models.Account.create({
    householdId,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name: 'Brokerage',
    accountType: 'investment',
    defaultCurrency: 'CAD',
    shortCode: 'INV',
  });
  await createTxn(householdId, inv.id, isoDaysAgo(now, 10), 'WS BUY 100 XEQT', -5000, null, 'purchase');

  await runDetectorsForHousehold(householdId, { now });
  const persisted = await models.Insight.findAll({ where: { householdId } });
  assert.equal(
    persisted.filter((p) => p.type === 'duplicate_transactions').length,
    0,
    'transfers must not surface as duplicate charges',
  );
  assert.equal(
    persisted.filter((p) => p.type === 'merchant_spend_spike').length,
    0,
    'a growing bill payment is not a spend spike',
  );
  assert.equal(
    persisted.filter((p) => p.type === 'missing_receipt').length,
    0,
    'money-movement rows are not missing-receipt spend',
  );
});

test('runDetectorsForHousehold preserves user status across reruns (dismissed stays dismissed)', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId } = await seedHousehold('A');
  await createTxn(householdId, accountId, isoDaysAgo(now, 2), 'Costco', -123.45);
  await createTxn(householdId, accountId, isoDaysAgo(now, 1), 'Costco', -123.45);

  await runDetectorsForHousehold(householdId, { now });
  const row = await models.Insight.findOne({
    where: { householdId, type: 'duplicate_transactions' },
  });
  assert.ok(row);
  row!.set('status', 'dismissed');
  await row!.save();

  await runDetectorsForHousehold(householdId, { now });
  const after = await models.Insight.findOne({
    where: { householdId, type: 'duplicate_transactions' },
  });
  assert.equal(after!.status, 'dismissed');
});

// ---- cash_runway_low + category_trend wiring (issue #797) --------------

async function seedPlannedExpense(
  householdId: number,
  userId: number,
  accountId: number,
  date: string,
  amount: number,
): Promise<void> {
  await models.PlannedEvent.create({
    userId,
    householdId,
    accountId,
    type: 'expense',
    name: 'Rent',
    amount: amount.toFixed(4),
    currency: 'CAD',
    expectedDate: date,
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
  });
}

test('runDetectorsForHousehold persists a category_trend insight', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId } = await seedHousehold('T');
  // Prior 3 full months trend up: Feb 200 → Mar 250 → Apr 300 (+50%).
  await createTxn(householdId, accountId, '2026-02-10', 'WholeFoods', -200, 'Groceries');
  await createTxn(householdId, accountId, '2026-03-10', 'WholeFoods', -250, 'Groceries');
  await createTxn(householdId, accountId, '2026-04-10', 'WholeFoods', -300, 'Groceries');

  const result = await runDetectorsForHousehold(householdId, { now });
  const persisted = await models.Insight.findAll({ where: { householdId, type: 'category_trend' } });
  assert.equal(persisted.length, 1);
  assert.ok(persisted[0].fingerprint.startsWith('category-trend:CAD:groceries:'));
  assert.equal(result.detectorCounts['category_trend'], 1);
});

test('runDetectorsForHousehold persists a cash_runway_low insight when projection crosses negative', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId, userId } = await seedHousehold('R');
  // Opening cash: one prior inflow of +500 (before the forecast window).
  await createTxn(householdId, accountId, '2026-05-01', 'Paycheck', 500, null, 'income');
  // A large planned expense inside the 30-day horizon drives the balance < 0.
  await seedPlannedExpense(householdId, userId, accountId, '2026-05-25', 2000);

  const result = await runDetectorsForHousehold(householdId, { now });
  const persisted = await models.Insight.findAll({ where: { householdId, type: 'cash_runway_low' } });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].entityType, 'forecast');
  assert.equal(persisted[0].entityId, null);
  assert.ok(persisted[0].fingerprint.startsWith('runway:CAD:'));
  assert.equal(result.detectorCounts['cash_runway_low'], 1);
});

test('runDetectorsForHousehold: new detectors are idempotent and preserve dismissal', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId, userId } = await seedHousehold('T');
  await createTxn(householdId, accountId, '2026-02-10', 'WholeFoods', -200, 'Groceries');
  await createTxn(householdId, accountId, '2026-03-10', 'WholeFoods', -250, 'Groceries');
  await createTxn(householdId, accountId, '2026-04-10', 'WholeFoods', -300, 'Groceries');
  await createTxn(householdId, accountId, '2026-05-01', 'Paycheck', 500, null, 'income');
  await seedPlannedExpense(householdId, userId, accountId, '2026-05-25', 2000);

  const first = await runDetectorsForHousehold(householdId, { now });
  const second = await runDetectorsForHousehold(householdId, { now });
  // Re-run over unchanged data: no new rows, the new findings come back refreshed.
  const rows = await models.Insight.findAll({ where: { householdId } });
  assert.equal(rows.length, first.total);
  assert.equal(second.created, 0);

  // Dismiss the runway + trend rows, re-run, assert they stay dismissed.
  for (const type of ['cash_runway_low', 'category_trend'] as const) {
    const row = await models.Insight.findOne({ where: { householdId, type } });
    assert.ok(row, `expected a ${type} row`);
    row!.set('status', 'dismissed');
    await row!.save();
  }
  await runDetectorsForHousehold(householdId, { now });
  for (const type of ['cash_runway_low', 'category_trend'] as const) {
    const row = await models.Insight.findOne({ where: { householdId, type } });
    assert.equal(row!.status, 'dismissed', `${type} should remain dismissed`);
  }
});

// ---- stale-insight sweep -------------------------------------------------
//
// A detector run retires the open rows it no longer produces. The sweep is
// scoped to the types the run's own detector roster covers, so rows written by
// OTHER producers (subscription_price_increase from the subscription-price job,
// the money-leak types from routes/moneyLeaks.ts) must survive untouched.

async function seedInsight(
  householdId: number,
  type: string,
  fingerprint: string,
  status: 'open' | 'dismissed' | 'resolved' = 'open',
): Promise<number> {
  const row = await models.Insight.create({
    householdId,
    userId: null,
    type: type as never,
    severity: 'info',
    title: `${type} ${fingerprint}`,
    description: null,
    entityType: null,
    entityId: null,
    status,
    fingerprint,
    metadata: { seeded: true },
    detectedAt: new Date('2026-01-01T00:00:00Z'),
  });
  return row.id;
}

test('sweep resolves an open insight the run no longer emits', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId } = await seedHousehold('A');
  await createTxn(householdId, accountId, isoDaysAgo(now, 2), 'Costco', -123.45);
  const dropId = await createTxn(householdId, accountId, isoDaysAgo(now, 1), 'Costco', -123.45);
  // A second, independent duplicate pair that stays intact.
  await createTxn(householdId, accountId, isoDaysAgo(now, 2), 'Shell', -80.10);
  await createTxn(householdId, accountId, isoDaysAgo(now, 1), 'Shell', -80.10);

  await runDetectorsForHousehold(householdId, { now });
  const rows = await models.Insight.findAll({ where: { householdId, type: 'duplicate_transactions' } });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'open'));
  const costco = rows.find((r) => r.fingerprint.includes('costco'));
  const shell = rows.find((r) => r.fingerprint.includes('shell'));
  assert.ok(costco && shell);

  // Delete one leg of the Costco pair: that duplicate finding no longer exists.
  await models.Transaction.destroy({ where: { id: dropId } });
  const second = await runDetectorsForHousehold(householdId, { now });

  await costco!.reload();
  await shell!.reload();
  assert.equal(costco!.status, 'resolved', 'the vanished duplicate must be retired');
  assert.equal(shell!.status, 'open', 'a finding still emitted stays open');
  assert.equal(second.resolved, 1);
});

test('sweep leaves still-emitted findings open and refreshed, resolving nothing', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId } = await seedHousehold('A');
  await createTxn(householdId, accountId, isoDaysAgo(now, 2), 'Costco', -123.45);
  await createTxn(householdId, accountId, isoDaysAgo(now, 1), 'Costco', -123.45);

  const first = await runDetectorsForHousehold(householdId, { now });
  assert.equal(first.resolved, 0);
  const before = await models.Insight.findOne({
    where: { householdId, type: 'duplicate_transactions' },
  });
  assert.ok(before);
  const detectedBefore = before!.detectedAt.getTime();

  // Same calendar day, later clock time: every date-bucketed detector window
  // is unchanged, so nothing can go stale — only `detected_at` should move.
  const later = new Date('2026-05-15T18:00:00Z');
  const second = await runDetectorsForHousehold(householdId, { now: later });
  assert.equal(second.resolved, 0, 'nothing went stale');
  assert.equal(second.created, 0);
  assert.equal(second.refreshed, first.total);

  await before!.reload();
  assert.equal(before!.status, 'open');
  assert.ok(
    before!.detectedAt.getTime() > detectedBefore,
    'a still-emitted finding is refreshed, not resolved',
  );
});

test('sweep never touches dismissed rows', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId, accountId } = await seedHousehold('A');
  await createTxn(householdId, accountId, isoDaysAgo(now, 2), 'Costco', -123.45);
  const dropId = await createTxn(householdId, accountId, isoDaysAgo(now, 1), 'Costco', -123.45);

  await runDetectorsForHousehold(householdId, { now });
  const dup = await models.Insight.findOne({
    where: { householdId, type: 'duplicate_transactions' },
  });
  assert.ok(dup);
  dup!.set('status', 'dismissed');
  await dup!.save();

  // Now make the finding go stale — the sweep would resolve it if it were open.
  await models.Transaction.destroy({ where: { id: dropId } });
  await runDetectorsForHousehold(householdId, { now });

  await dup!.reload();
  assert.equal(dup!.status, 'dismissed', 'a dismissal is a user decision, not ours to rewrite');
});

test('sweep leaves types this run does not produce alone', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId } = await seedHousehold('A');
  // Written by other producers: the subscription-price job and money-leak
  // detection. This run knows nothing about their findings.
  const foreignIds = await Promise.all([
    seedInsight(householdId, 'subscription_price_increase', 'sub:netflix:2026-05'),
    seedInsight(householdId, 'small_subscription', 'small_subscription|spotify'),
    seedInsight(householdId, 'recurring_fee', 'recurring_fee|bank'),
    seedInsight(householdId, 'duplicate_service', 'duplicate_service|streaming'),
    seedInsight(householdId, 'delivery_fee_high', 'delivery_fee_high|ubereats'),
  ]);
  // A covered-type row with no backing finding — this one SHOULD be swept.
  const staleId = await seedInsight(householdId, 'duplicate_transactions', 'dupe:999');

  const result = await runDetectorsForHousehold(householdId, { now });

  for (const id of foreignIds) {
    const row = await models.Insight.findByPk(id);
    assert.equal(row!.status, 'open', `${row!.type} belongs to another producer`);
  }
  const stale = await models.Insight.findByPk(staleId);
  assert.equal(stale!.status, 'resolved');
  assert.equal(result.resolved, 1);
});

test('sweep is scoped to the household being run', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const a = await seedHousehold('A');
  const b = await seedHousehold('B');
  const aStale = await seedInsight(a.householdId, 'duplicate_transactions', 'dupe:a');
  const bStale = await seedInsight(b.householdId, 'duplicate_transactions', 'dupe:b');

  const result = await runDetectorsForHousehold(b.householdId, { now });

  assert.equal((await models.Insight.findByPk(aStale))!.status, 'open', 'other households untouched');
  assert.equal((await models.Insight.findByPk(bStale))!.status, 'resolved');
  assert.equal(result.resolved, 1);
});

test('sweep reports an accurate resolved count', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId } = await seedHousehold('A');
  const staleIds = await Promise.all([
    seedInsight(householdId, 'duplicate_transactions', 'dupe:1'),
    seedInsight(householdId, 'missing_receipt', 'receipt:1'),
    seedInsight(householdId, 'merchant_spend_spike', 'spike:1'),
    seedInsight(householdId, 'settlement_imbalance', 'settle:1'),
  ]);
  // Neither of these counts: one is dismissed, one is already resolved.
  await seedInsight(householdId, 'category_trend', 'trend:1', 'dismissed');
  await seedInsight(householdId, 'cash_runway_low', 'runway:1', 'resolved');

  const result = await runDetectorsForHousehold(householdId, { now });
  assert.equal(result.total, 0, 'no transactions seeded, so no findings');
  assert.equal(result.resolved, staleIds.length);

  // A second run has nothing left to retire.
  const second = await runDetectorsForHousehold(householdId, { now });
  assert.equal(second.resolved, 0);
});

// ---- reopen on recurrence -------------------------------------------------
//
// The sweep can mark a row `resolved`. If the same fingerprint fires again on
// a later run, the finding has demonstrably recurred and must become visible
// again — otherwise it is silently lost forever (issue: settle up, resolves;
// fall back out of balance, refreshed but stuck `resolved`).

test('a resolved row whose finding recurs round-trips: open -> resolved -> open again', async () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const { householdId } = await seedHousehold('A');
  const contact = await models.Contact.create({ householdId, name: 'Jamie' });

  const seedSettlement = (amount: number) =>
    models.PartnerSettlement.create({
      householdId,
      recordedByUserId: null,
      contactId: contact.id,
      direction: 'i_paid_partner',
      currency: 'CAD',
      amount: amount.toFixed(4),
      settledDate: '2026-05-01',
      notes: null,
    });

  // 1. Finding present: an imbalance over the $100 threshold -> open.
  const s1 = await seedSettlement(500);
  const first = await runDetectorsForHousehold(householdId, { now });
  assert.equal(first.created, 1);
  let row = await models.Insight.findOne({ where: { householdId, type: 'settlement_imbalance' } });
  assert.ok(row);
  assert.equal(row!.status, 'open');
  assert.equal(row!.fingerprint, `settlement:${contact.id}:CAD`);

  // 2. Finding gone: settle up (no outstanding settlement rows left) -> the
  //    sweep resolves it.
  await s1.destroy();
  const second = await runDetectorsForHousehold(householdId, { now });
  assert.equal(second.resolved, 1);
  await row!.reload();
  assert.equal(row!.status, 'resolved', 'settling up must retire the imbalance insight');

  // 3. Finding returns: fall back out of balance with the SAME contact/currency
  //    fingerprint -> must reopen, not stay silently resolved.
  await seedSettlement(750);
  const third = await runDetectorsForHousehold(householdId, { now });
  assert.equal(third.reopened, 1, 'the recurring imbalance must be counted as reopened');
  assert.equal(third.created, 0, 'same fingerprint — must not create a duplicate row');
  await row!.reload();
  assert.equal(row!.status, 'open', 'a recurring finding must become visible again');
  assert.equal(await models.Insight.count({ where: { householdId, type: 'settlement_imbalance' } }), 1);
});
