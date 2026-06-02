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
after(async () => { await sequelize.close(); });

let householdId: number;
beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

function txnDefaults(accountId: number, extra: Record<string, unknown> = {}) {
  return {
    accountId,
    householdId,
    date: '2026-01-15',
    merchantRaw: 'X',
    merchantClean: 'X',
    amount: '10.00',
    currency: 'CAD',
    importBatch: 'test',
    sourceRowFingerprint: `fp-${Math.random()}`,
    sourceIdentityFingerprint: `fp-${Math.random()}`,
    ...extra,
  };
}

test('new transaction inherits entityId from its account', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const account = await Account.create({ name: 'Corp', owner: 'me', householdId, entityId: corp.id });
  const t = await Transaction.create(txnDefaults(account.id) as never);
  assert.equal(t.entityId, corp.id);
});

test('inherits the personal entity for a default (personal) account', async () => {
  const account = await Account.create({ name: 'Personal', owner: 'me', householdId });
  const personal = await Entity.findOne({ where: { householdId, kind: 'personal' } });
  const t = await Transaction.create(txnDefaults(account.id) as never);
  assert.equal(t.entityId, personal!.id);
});

test('explicit transaction entityId is preserved', async () => {
  const personal = await Entity.create({ householdId, kind: 'personal', legalName: 'Personal' });
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const account = await Account.create({ name: 'Personal', owner: 'me', householdId, entityId: personal.id });
  const t = await Transaction.create(txnDefaults(account.id, { entityId: corp.id }) as never);
  assert.equal(t.entityId, corp.id);
});

test('leaves entityId unset when the account itself has none', async () => {
  const account = await Account.create({ name: 'Orphan', owner: 'me', householdId: null });
  const t = await Transaction.create(txnDefaults(account.id, { householdId: null }) as never);
  assert.ok(t.entityId == null, `expected no entity, got ${t.entityId}`);
});

test('build()+save() path (import) also inherits', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const account = await Account.create({ name: 'Corp', owner: 'me', householdId, entityId: corp.id });
  const t = Transaction.build(txnDefaults(account.id) as never);
  await t.save();
  assert.equal(t.entityId, corp.id);
});
