import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;
let Transaction: typeof import('../src/models/Transaction').Transaction;
let buildBundle: typeof import('../src/sync/buildBundle').buildBundle;
let restoreBundle: typeof import('../src/sync/restoreBundle').restoreBundle;

before(async () => {
  const models = await import('../src/models');
  ({ sequelize, Account, Entity, Household, Transaction } = models);
  ({ buildBundle } = await import('../src/sync/buildBundle'));
  ({ restoreBundle } = await import('../src/sync/restoreBundle'));
  await sequelize.sync({ force: true });
});
after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
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

test('restore re-derives entity_id to the TARGET household personal entity, ignoring the source entity_id', async () => {
  // Source household: an account + txn tagged with the SOURCE personal entity.
  const source = await Household.create({ name: 'Source' });
  const sourceAccount = await Account.create({ name: 'Src Chequing', owner: 'me', householdId: source.id });
  await seedTxn(sourceAccount.id, source.id);
  const sourcePersonal = await Entity.findOne({ where: { householdId: source.id, kind: 'personal' } });
  assert.ok(sourcePersonal, 'source personal entity created by the account hook');
  assert.equal(sourceAccount.entityId, sourcePersonal!.id);

  const payload = await buildBundle(sequelize, { householdId: source.id, origin: 'test' });
  // Sanity: the bundle carries the source entity id verbatim (no remap on export).
  const acctRows = payload.tables.accounts as Array<{ entity_id: number | null }>;
  assert.equal(acctRows[0].entity_id, sourcePersonal!.id);

  // Restore into a DIFFERENT (empty) target household.
  const target = await Household.create({ name: 'Target' });
  const result = await restoreBundle(sequelize, payload, { householdId: target.id, mode: 'merge' });
  assert.equal(result.inserted.accounts, 1);
  assert.equal(result.inserted.transactions, 1);

  // The target household must now have its OWN personal entity, and the
  // restored rows must point at it — never at the source entity id.
  const targetPersonal = await Entity.findOne({ where: { householdId: target.id, kind: 'personal' } });
  assert.ok(targetPersonal, 'target personal entity created during restore re-derivation');
  assert.notEqual(targetPersonal!.id, sourcePersonal!.id);

  const restoredAccount = await Account.findOne({ where: { householdId: target.id } });
  assert.ok(restoredAccount, 'account restored into target household');
  assert.equal(restoredAccount!.entityId, targetPersonal!.id);

  const restoredTxn = await Transaction.findOne({ where: { householdId: target.id } });
  assert.ok(restoredTxn, 'transaction restored into target household');
  assert.equal(restoredTxn!.entityId, targetPersonal!.id);
});

test('restore re-derives even a legacy bundle whose rows carry NULL entity_id', async () => {
  // Simulate a pre-#526 export: the bundle's account + txn have NULL entity_id.
  const source = await Household.create({ name: 'Source2' });
  const sourceAccount = await Account.create({ name: 'Src2', owner: 'me', householdId: source.id });
  await seedTxn(sourceAccount.id, source.id);

  const payload = await buildBundle(sequelize, { householdId: source.id, origin: 'test' });
  (payload.tables.accounts as Array<{ entity_id: number | null }>).forEach((r) => {
    r.entity_id = null;
  });
  (payload.tables.transactions as Array<{ entity_id: number | null }>).forEach((r) => {
    r.entity_id = null;
  });

  const target = await Household.create({ name: 'Target2' });
  await restoreBundle(sequelize, payload, { householdId: target.id, mode: 'merge' });

  const accountsNull = await Account.count({ where: { householdId: target.id, entityId: null } });
  assert.equal(accountsNull, 0, 'no restored account left with NULL entity_id');
  const txnsNull = await Transaction.count({ where: { householdId: target.id, entityId: null } });
  assert.equal(txnsNull, 0, 'no restored transaction left with NULL entity_id');
});
