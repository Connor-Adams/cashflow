/**
 * restoreBundle must never plant a foreign user id (Cashflow #837, security).
 *
 * The bundle carries `owner_user_id` (accounts) and `created_by_user_id`
 * (rules, transactions) verbatim. A crafted bundle could set these to a user
 * id from ANOTHER household; restoring it would mis-attribute ownership /
 * authorship and corrupt owner-scoped `visibility` queries. Restore must
 * normalize every non-null user id to the restoring user's id (the only safe
 * known-member value) and leave NULLs as NULL.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../models/Account').Account;
let Household: typeof import('../models/Household').Household;
let Rule: typeof import('../models/Rule').Rule;
let Transaction: typeof import('../models/Transaction').Transaction;
let buildBundle: typeof import('./buildBundle').buildBundle;
let restoreBundle: typeof import('./restoreBundle').restoreBundle;

before(async () => {
  const models = await import('../models');
  ({ sequelize, Account, Household, Rule, Transaction } = models);
  ({ buildBundle } = await import('./buildBundle'));
  ({ restoreBundle } = await import('./restoreBundle'));
  await sequelize.sync({ force: true });
});
after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Rule.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
});

async function seedTxn(accountId: number, householdId: number): Promise<void> {
  await Transaction.create({
    accountId,
    householdId,
    importBatch: 'b',
    date: '2026-01-01',
    merchantRaw: 'M',
    merchantClean: 'M',
    amount: '1.0000',
    currency: 'CAD',
    sourceRowFingerprint: `fp-${Math.random()}`,
    sourceIdentityFingerprint: `id-${Math.random()}`,
    reviewFlag: false,
  });
}

const FOREIGN_USER_ID = 9999;
const RESTORING_USER_ID = 42;

test('restore rewrites a foreign owner_user_id / created_by_user_id to the restoring user', async () => {
  const source = await Household.create({ name: 'Source' });
  const sourceAccount = await Account.create({
    name: 'Src Chequing',
    owner: 'me',
    householdId: source.id,
  });
  await Rule.create({
    merchantPattern: 'COFFEE',
    householdId: source.id,
    matchKind: 'contains',
    priority: 1,
  });
  await seedTxn(sourceAccount.id, source.id);

  const payload = await buildBundle(sequelize, { householdId: source.id, origin: 'test' });

  // Craft the bundle: plant a foreign user id everywhere the column lives.
  (payload.tables.accounts as Array<{ owner_user_id: number | null }>).forEach((r) => {
    r.owner_user_id = FOREIGN_USER_ID;
  });
  (payload.tables.rules as Array<{ created_by_user_id: number | null }>).forEach((r) => {
    r.created_by_user_id = FOREIGN_USER_ID;
  });
  (payload.tables.transactions as Array<{ created_by_user_id: number | null }>).forEach((r) => {
    r.created_by_user_id = FOREIGN_USER_ID;
  });

  const target = await Household.create({ name: 'Target' });
  await restoreBundle(sequelize, payload, {
    householdId: target.id,
    userId: RESTORING_USER_ID,
    mode: 'merge',
  });

  const restoredAccount = await Account.findOne({ where: { householdId: target.id } });
  assert.ok(restoredAccount, 'account restored');
  assert.equal(
    restoredAccount!.ownerUserId,
    RESTORING_USER_ID,
    'foreign owner_user_id normalized to restoring user',
  );

  const restoredRule = await Rule.findOne({ where: { householdId: target.id } });
  assert.ok(restoredRule, 'rule restored');
  assert.equal(
    restoredRule!.createdByUserId,
    RESTORING_USER_ID,
    'foreign rule created_by_user_id normalized to restoring user',
  );

  const restoredTxn = await Transaction.findOne({ where: { householdId: target.id } });
  assert.ok(restoredTxn, 'transaction restored');
  assert.equal(
    restoredTxn!.createdByUserId,
    RESTORING_USER_ID,
    'foreign txn created_by_user_id normalized to restoring user',
  );
});

test('restore leaves NULL user-id columns as NULL', async () => {
  const source = await Household.create({ name: 'Source2' });
  const sourceAccount = await Account.create({
    name: 'Src2',
    owner: 'me',
    householdId: source.id,
  });
  await seedTxn(sourceAccount.id, source.id);

  const payload = await buildBundle(sequelize, { householdId: source.id, origin: 'test' });
  (payload.tables.accounts as Array<{ owner_user_id: number | null }>).forEach((r) => {
    r.owner_user_id = null;
  });
  (payload.tables.transactions as Array<{ created_by_user_id: number | null }>).forEach((r) => {
    r.created_by_user_id = null;
  });

  const target = await Household.create({ name: 'Target2' });
  await restoreBundle(sequelize, payload, {
    householdId: target.id,
    userId: RESTORING_USER_ID,
    mode: 'merge',
  });

  const restoredAccount = await Account.findOne({ where: { householdId: target.id } });
  assert.equal(restoredAccount!.ownerUserId, null, 'NULL owner_user_id stays NULL');
  const restoredTxn = await Transaction.findOne({ where: { householdId: target.id } });
  assert.equal(restoredTxn!.createdByUserId, null, 'NULL created_by_user_id stays NULL');
});

test('restore without a userId leaves user-id columns NULL (no foreign id planted)', async () => {
  // Defensive: if a caller omits userId, we must NOT trust the bundle value.
  const source = await Household.create({ name: 'Source3' });
  const sourceAccount = await Account.create({
    name: 'Src3',
    owner: 'me',
    householdId: source.id,
  });
  await seedTxn(sourceAccount.id, source.id);

  const payload = await buildBundle(sequelize, { householdId: source.id, origin: 'test' });
  (payload.tables.accounts as Array<{ owner_user_id: number | null }>).forEach((r) => {
    r.owner_user_id = FOREIGN_USER_ID;
  });
  (payload.tables.transactions as Array<{ created_by_user_id: number | null }>).forEach((r) => {
    r.created_by_user_id = FOREIGN_USER_ID;
  });

  const target = await Household.create({ name: 'Target3' });
  await restoreBundle(sequelize, payload, { householdId: target.id, mode: 'merge' });

  const restoredAccount = await Account.findOne({ where: { householdId: target.id } });
  assert.equal(
    restoredAccount!.ownerUserId,
    null,
    'no userId → foreign owner_user_id nulled, never planted',
  );
  const restoredTxn = await Transaction.findOne({ where: { householdId: target.id } });
  assert.equal(
    restoredTxn!.createdByUserId,
    null,
    'no userId → foreign created_by_user_id nulled, never planted',
  );
});
