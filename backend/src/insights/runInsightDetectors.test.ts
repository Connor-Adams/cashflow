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
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Contact.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

async function seedHousehold(name: string): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name });
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
  return { householdId: hh.id, accountId: account.id };
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
