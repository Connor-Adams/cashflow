import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('./Account').Account;
let Entity: typeof import('./Entity').Entity;
let Household: typeof import('./Household').Household;

before(async () => {
  const models = await import('./');
  ({ sequelize, Account, Entity, Household } = models);
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });

let householdId: number;
beforeEach(async () => {
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

test('new account with no entityId gets the household personal entity', async () => {
  const a = await Account.create({ name: 'Chequing', owner: 'me', householdId });
  const personal = await Entity.findOne({ where: { householdId, kind: 'personal' } });
  assert.ok(personal, 'personal entity should have been created');
  assert.equal(a.entityId, personal!.id);
});

test('explicit entityId (e.g. corp) is preserved — not overwritten', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const a = await Account.create({ name: 'Corp Chequing', owner: 'me', householdId, entityId: corp.id });
  assert.equal(a.entityId, corp.id);
  assert.equal(await Entity.count({ where: { householdId, kind: 'personal' } }), 0);
});

test('account without a householdId is left unset (no entity to default to)', async () => {
  const a = await Account.create({ name: 'Orphan', owner: 'me', householdId: null });
  assert.ok(a.entityId == null, `expected no entity, got ${a.entityId}`);
});

test('findOrCreate path also fills entityId (bulk-safe)', async () => {
  const [a] = await Account.findOrCreate({
    where: { householdId, shortCode: 'WS1' },
    defaults: { name: 'WS', owner: 'me', householdId, shortCode: 'WS1' },
  });
  const personal = await Entity.findOne({ where: { householdId, kind: 'personal' } });
  assert.equal(a.entityId, personal!.id);
});

test('account creation never fails when the household row is missing (orphan FK)', async () => {
  // householdId 99999 does not exist → getOrCreatePersonalEntity would hit a
  // FK violation. The hook must swallow it and still create the account with a
  // null entity (the repair service can backfill later); it must never break
  // account creation.
  let a: InstanceType<typeof Account>;
  await assert.doesNotReject(async () => {
    a = await Account.create({ name: 'Orphan HH', owner: 'me', householdId: 99999 });
  });
  assert.ok(a! && a!.id, 'account should have been created');
  assert.ok(a!.entityId == null, `expected no entity, got ${a!.entityId}`);
});
