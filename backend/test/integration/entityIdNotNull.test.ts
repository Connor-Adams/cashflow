/**
 * Integration tests for the entity_id NOT NULL + ON DELETE NO ACTION hardening
 * (follow-up to PR #527, originally-approved design item 9).
 *
 * These run the full migration chain against a real Postgres (see
 * _setup/pgTestDb) because the constraint is Postgres-only: on SQLite the
 * migration is a no-op and the column stays nullable, mirroring
 * 20260524210000-stable-identity-fingerprint and
 * 20260618000001-entity-id-foreign-keys. The Sequelize model field stays
 * allowNull:true — the fill hooks run on beforeCreate, AFTER validation, so an
 * allowNull:false model field would reject every create before the hook fills
 * entity_id (see backend/src/models/Account.ts / Transaction.ts).
 *
 * Proves:
 *   1. accounts.entity_id rejects NULL at the DB layer.
 *   2. transactions.entity_id rejects NULL at the DB layer.
 *   3. the entity FK is ON DELETE NO ACTION: deleting a tax_entity still
 *      referenced by an account is blocked. (ON DELETE SET NULL — the prior
 *      behavior — would instead write NULL into the column, which a NOT NULL
 *      column cannot hold, so SET NULL is incompatible with NOT NULL.)
 *   4. household teardown (households ON DELETE CASCADE) still succeeds: the
 *      NO ACTION entity FK does not abort the cascade, because tax_entities is
 *      NOT cascade-deleted with the household (it has no household FK).
 *   5. the normal create path still satisfies NOT NULL: the model fill hooks
 *      populate entity_id so a plain Account.create / Transaction.create works.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { QueryTypes } from 'sequelize';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let models: any;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('entity_notnull');
  models = await import('../../src/models');
});

after(async () => {
  await teardownPgTestDb(testDb);
});

/** Fresh household + account; the beforeCreate hook fills account.entityId
 *  from the household's personal tax entity. ownerUserId is left null (the FK
 *  is ON DELETE SET NULL) to avoid seeding a full user. */
async function seedAccount(label: string): Promise<{
  householdId: number;
  accountId: number;
  entityId: number;
}> {
  const household = await models.Household.create({ name: `${label} household` });
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: null,
    owner: 'me',
    visibility: 'private',
    name: `${label} chequing`,
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: null,
  });
  assert.ok(account.entityId != null, 'hook should have filled entity_id');
  return { householdId: household.id, accountId: account.id, entityId: account.entityId };
}

async function seedTransaction(householdId: number, accountId: number): Promise<{
  id: number;
  entityId: number | null;
}> {
  const txn = await models.Transaction.create({
    accountId,
    householdId,
    importBatch: 'entity-notnull-test',
    date: '2026-01-15',
    merchantRaw: 'Coffee Co',
    merchantClean: 'Coffee Co',
    amount: '4.50',
    currency: 'CAD',
    sourceRowFingerprint: `fp-${crypto.randomBytes(8).toString('hex')}`,
    sourceIdentityFingerprint: `id-${crypto.randomBytes(8).toString('hex')}`,
    finalCategory: 'Food',
  });
  return { id: txn.id, entityId: txn.entityId };
}

test('accounts.entity_id rejects NULL at the DB layer', async () => {
  const { accountId } = await seedAccount('acct-null');
  await assert.rejects(
    () =>
      models.sequelize.query(
        'UPDATE accounts SET entity_id = NULL WHERE id = :id',
        { replacements: { id: accountId }, type: QueryTypes.UPDATE },
      ),
    /not-null|null value/i,
    'setting accounts.entity_id NULL must violate the NOT NULL constraint',
  );
});

test('transactions.entity_id rejects NULL at the DB layer', async () => {
  const { householdId, accountId } = await seedAccount('txn-null');
  const { id, entityId } = await seedTransaction(householdId, accountId);
  assert.ok(entityId != null, 'txn hook should have inherited entity_id from account');
  await assert.rejects(
    () =>
      models.sequelize.query(
        'UPDATE transactions SET entity_id = NULL WHERE id = :id',
        { replacements: { id }, type: QueryTypes.UPDATE },
      ),
    /not-null|null value/i,
    'setting transactions.entity_id NULL must violate the NOT NULL constraint',
  );
});

test('entity FK is ON DELETE NO ACTION: deleting a referenced tax_entity is blocked', async () => {
  const { entityId } = await seedAccount('fk-block');
  await assert.rejects(
    () =>
      models.sequelize.query(
        'DELETE FROM tax_entities WHERE id = :id',
        { replacements: { id: entityId }, type: QueryTypes.DELETE },
      ),
    /foreign key constraint/i,
    'deleting a tax_entity referenced by an account must be blocked, not SET NULL',
  );
});

test('household teardown cascades accounts+transactions; NO ACTION entity FK does not block it', async () => {
  const { householdId, accountId, entityId } = await seedAccount('teardown');
  await seedTransaction(householdId, accountId);

  await assert.doesNotReject(
    () =>
      models.sequelize.query(
        'DELETE FROM households WHERE id = :id',
        { replacements: { id: householdId }, type: QueryTypes.DELETE },
      ),
    'deleting the household must succeed despite the NO ACTION entity FK',
  );

  const [acct] = await models.sequelize.query(
    'SELECT count(*)::int AS n FROM accounts WHERE household_id = :id',
    { replacements: { id: householdId }, type: QueryTypes.SELECT },
  );
  const [txn] = await models.sequelize.query(
    'SELECT count(*)::int AS n FROM transactions WHERE household_id = :id',
    { replacements: { id: householdId }, type: QueryTypes.SELECT },
  );
  const [ent] = await models.sequelize.query(
    'SELECT count(*)::int AS n FROM tax_entities WHERE id = :id',
    { replacements: { id: entityId }, type: QueryTypes.SELECT },
  );
  assert.equal(acct.n, 0, 'accounts cascade-deleted with the household');
  assert.equal(txn.n, 0, 'transactions cascade-deleted with the household');
  assert.equal(ent.n, 1, 'tax_entity survives (no household FK to cascade through)');
});

test('normal Account.create / Transaction.create satisfy NOT NULL via fill hooks', async () => {
  const { householdId, accountId, entityId } = await seedAccount('happy');
  assert.ok(entityId != null, 'account create filled entity_id');
  const { entityId: txnEntityId } = await seedTransaction(householdId, accountId);
  assert.equal(txnEntityId, entityId, 'transaction inherits the account entity_id');
});
