import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;
let linkWsAccountToCorpEntity: typeof import('../src/import/runImport').linkWsAccountToCorpEntity;

before(async () => {
  const models = await import('../src/models');
  ({ sequelize, Account, Entity, Household } = models);
  ({ linkWsAccountToCorpEntity } = await import('../src/import/runImport'));
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

test('links a WS corp account to the household corp entity (uppercase legal name)', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'CDG LABS INC.' });
  const account = await Account.create({
    name: 'Wealthsimple Corporate Investing',
    owner: 'me',
    householdId,
    entityId: null,
  });
  await linkWsAccountToCorpEntity(account, 'corporate_investing', householdId);
  await account.reload();
  assert.equal(account.entityId, corp.id);
});

test('non-corp WS product leaves the account entity untouched', async () => {
  await Entity.create({ householdId, kind: 'corp', legalName: 'CDG LABS INC.' });
  const account = await Account.create({ name: 'Wealthsimple TFSA', owner: 'me', householdId });
  const before = account.entityId; // personal default from the Account hook
  await linkWsAccountToCorpEntity(account, 'tfsa', householdId);
  await account.reload();
  assert.equal(account.entityId, before);
});

test('no-op when the household has no corp entity yet', async () => {
  const account = await Account.create({ name: 'Wealthsimple Save for Business', owner: 'me', householdId });
  const before = account.entityId;
  await linkWsAccountToCorpEntity(account, 'save_for_business', householdId);
  await account.reload();
  assert.equal(account.entityId, before);
});

test('idempotent — second call makes no further change', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'CDG LABS INC.' });
  const account = await Account.create({ name: 'WS Corporate Chequing', owner: 'me', householdId });
  await linkWsAccountToCorpEntity(account, 'corporate_chequing', householdId);
  await linkWsAccountToCorpEntity(account, 'corporate_chequing', householdId);
  await account.reload();
  assert.equal(account.entityId, corp.id);
});
