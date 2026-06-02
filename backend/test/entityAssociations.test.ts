import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;
let Transaction: typeof import('../src/models/Transaction').Transaction;

before(async () => {
  const models = await import('../src/models');
  ({ sequelize, Account, Entity, Household, Transaction } = models);
  await sequelize.sync({ force: true });
});
after(async () => {
  await sequelize.close();
});

let householdId: number;
beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

test('Account.belongsTo(Entity) — eager include resolves the linked entity', async () => {
  // The Account beforeCreate hook tags it with the household personal entity.
  const account = await Account.create({ name: 'Chequing', owner: 'me', householdId });
  const loaded = await Account.findByPk(account.id, {
    include: [{ model: Entity, as: 'entity' }],
  });
  assert.ok(loaded, 'account exists');
  const entity = loaded!.get('entity') as InstanceType<typeof Entity> | undefined;
  assert.ok(entity, 'entity association resolved via include');
  assert.equal(entity!.id, account.entityId);
  assert.equal(entity!.kind, 'personal');
});

test('Transaction.belongsTo(Entity) — eager include resolves the linked entity', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const account = await Account.create({
    name: 'Corp',
    owner: 'me',
    householdId,
    entityId: corp.id,
  });
  // The Transaction beforeCreate hook inherits entity_id from its account.
  const txn = await Transaction.create({
    accountId: account.id,
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
  const loaded = await Transaction.findByPk(txn.id, {
    include: [{ model: Entity, as: 'entity' }],
  });
  const entity = loaded!.get('entity') as InstanceType<typeof Entity> | undefined;
  assert.ok(entity, 'entity association resolved via include');
  assert.equal(entity!.id, corp.id);
});

test('belongsTo(Entity) metadata is registered on both models', () => {
  assert.ok(Account.associations.entity, 'Account.associations.entity exists');
  assert.equal(Account.associations.entity.target, Entity);
  assert.equal(Account.associations.entity.as, 'entity');
  assert.ok(Transaction.associations.entity, 'Transaction.associations.entity exists');
  assert.equal(Transaction.associations.entity.target, Entity);
  assert.equal(Transaction.associations.entity.as, 'entity');
});
