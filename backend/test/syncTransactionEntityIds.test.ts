import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;
let Transaction: typeof import('../src/models/Transaction').Transaction;
let syncTransactionEntityIds: typeof import('../src/tax/services/syncTransactionEntityIds').syncTransactionEntityIds;

before(async () => {
  const models = await import('../src/models');
  ({ sequelize, Account, Entity, Household, Transaction } = models);
  ({ syncTransactionEntityIds } = await import('../src/tax/services/syncTransactionEntityIds'));
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });

let householdId: number;
let personalId: number;
let corpId: number;
beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
  personalId = (await Entity.create({ householdId, kind: 'personal', legalName: 'Personal' })).id;
  corpId = (await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' })).id;
});

// Insert raw so we bypass the inheritance hook and simulate legacy/divergent rows.
function rawTxn(accountId: number, entityId: number | null, hhId: number | null) {
  return sequelize.query(
    `INSERT INTO transactions
      (account_id, household_id, entity_id, date, merchant_raw, merchant_clean, amount, currency,
       import_batch, source_row_fingerprint, source_identity_fingerprint,
       visibility, ownership_type, status, final_business, final_split_type,
       my_share_amount, partner_share_amount, business_amount, txn_type, is_recurring,
       review_flag, created_at, updated_at)
     VALUES (:accountId, :hhId, :entityId, '2026-01-01', 'M', 'M', '1.0000', 'CAD',
       'b', :fp, :fp, 'private', 'me', 'posted', 0, 'me',
       0, 0, 0, 'purchase', 0, 0, :now, :now)`,
    { replacements: { accountId, hhId, entityId, fp: `fp-${Math.random()}`, now: new Date().toISOString() } },
  );
}

test('syncs mismatched and null transaction entity_ids to their account entity', async () => {
  const corpAccount = await Account.create({ name: 'Corp', owner: 'me', householdId, entityId: corpId });
  await rawTxn(corpAccount.id, null, householdId);        // NULL — should become corp
  await rawTxn(corpAccount.id, personalId, householdId);  // WRONG (personal) — should become corp

  const updated = await syncTransactionEntityIds(householdId);
  assert.equal(updated, 2);
  const rows = await Transaction.findAll({ where: { accountId: corpAccount.id } });
  assert.ok(rows.every((r) => r.entityId === corpId));
});

test('is idempotent — a second run updates nothing', async () => {
  const corpAccount = await Account.create({ name: 'Corp', owner: 'me', householdId, entityId: corpId });
  await rawTxn(corpAccount.id, null, householdId);
  assert.equal(await syncTransactionEntityIds(householdId), 1);
  assert.equal(await syncTransactionEntityIds(householdId), 0);
});

test('does not touch txns whose account entity_id is NULL', async () => {
  const nullAccount = await Account.create({ name: 'Orphan', owner: 'me', householdId: null });
  await rawTxn(nullAccount.id, null, null);
  assert.equal(await syncTransactionEntityIds(), 0);
  const [row] = await Transaction.findAll({ where: { accountId: nullAccount.id } });
  assert.ok(row.entityId == null);
});

test('scopes to a household when householdId is passed', async () => {
  const otherHh = (await Household.create({ name: 'Other' })).id;
  const otherCorp = (await Entity.create({ householdId: otherHh, kind: 'corp', legalName: 'Other Inc.' })).id;
  const a1 = await Account.create({ name: 'A1', owner: 'me', householdId, entityId: corpId });
  const a2 = await Account.create({ name: 'A2', owner: 'me', householdId: otherHh, entityId: otherCorp });
  await rawTxn(a1.id, null, householdId);
  await rawTxn(a2.id, null, otherHh);
  // Only household 1's row should be synced.
  const updated = await syncTransactionEntityIds(householdId);
  assert.equal(updated, 1);
  const [r2] = await Transaction.findAll({ where: { accountId: a2.id } });
  assert.ok(r2.entityId == null);
});
