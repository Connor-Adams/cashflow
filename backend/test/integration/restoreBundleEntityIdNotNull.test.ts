/**
 * Integration test: /api/sync/restore must still work once
 * accounts.entity_id / transactions.entity_id are NOT NULL (migration
 * 20260619000001).
 *
 * Postgres enforces NOT NULL at INSERT time (it is non-deferrable), so
 * restoreBundle cannot insert NULL-then-fix-afterwards: the NULL insert would
 * be rejected before any post-insert re-derivation runs, rolling back the whole
 * restore. restoreBundle must therefore insert the re-derived target-household
 * entity_id up front. This runs against real Postgres via the full migration
 * chain — the constraint is a no-op on the SQLite unit DB
 * (test/restoreBundleEntityId.test.ts covers the dialect-agnostic re-derivation
 * logic), so only Postgres exercises the NOT NULL interaction.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let models: any;
let buildBundle: typeof import('../../src/sync/buildBundle').buildBundle;
let restoreBundle: typeof import('../../src/sync/restoreBundle').restoreBundle;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('restore_entity_notnull');
  models = await import('../../src/models');
  ({ buildBundle } = await import('../../src/sync/buildBundle'));
  ({ restoreBundle } = await import('../../src/sync/restoreBundle'));
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function seedTxn(accountId: number, householdId: number): Promise<void> {
  await models.Transaction.create({
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

test('restore into a NOT NULL target succeeds and fills entity_id up front', async () => {
  const source = await models.Household.create({ name: 'Source' });
  const sourceAccount = await models.Account.create({
    name: 'Src Chequing',
    owner: 'me',
    householdId: source.id,
  });
  await seedTxn(sourceAccount.id, source.id);

  const payload = await buildBundle(models.sequelize, { householdId: source.id, origin: 'test' });

  const target = await models.Household.create({ name: 'Target' });
  const result = await restoreBundle(models.sequelize, payload, {
    householdId: target.id,
    mode: 'merge',
  });
  assert.equal(result.inserted.accounts, 1);
  assert.equal(result.inserted.transactions, 1);

  const targetPersonal = await models.Entity.findOne({
    where: { householdId: target.id, kind: 'personal' },
  });
  assert.ok(targetPersonal, 'target personal entity created during restore');

  const restoredAccount = await models.Account.findOne({ where: { householdId: target.id } });
  assert.ok(restoredAccount, 'account restored into target household');
  assert.equal(restoredAccount.entityId, targetPersonal.id, 'account → target personal entity');

  const restoredTxn = await models.Transaction.findOne({ where: { householdId: target.id } });
  assert.ok(restoredTxn, 'transaction restored into target household');
  assert.equal(restoredTxn.entityId, targetPersonal.id, 'transaction → target personal entity');
});

test('restore of a legacy bundle carrying NULL entity_id also succeeds under NOT NULL', async () => {
  const source = await models.Household.create({ name: 'Source2' });
  const sourceAccount = await models.Account.create({
    name: 'Src2',
    owner: 'me',
    householdId: source.id,
  });
  await seedTxn(sourceAccount.id, source.id);

  const payload = await buildBundle(models.sequelize, { householdId: source.id, origin: 'test' });
  // Simulate a pre-#526 export whose rows carry NULL entity_id.
  (payload.tables.accounts as Array<{ entity_id: number | null }>).forEach((r) => {
    r.entity_id = null;
  });
  (payload.tables.transactions as Array<{ entity_id: number | null }>).forEach((r) => {
    r.entity_id = null;
  });

  const target = await models.Household.create({ name: 'Target2' });
  await restoreBundle(models.sequelize, payload, { householdId: target.id, mode: 'merge' });

  const acctNull = await models.Account.count({
    where: { householdId: target.id, entityId: null },
  });
  assert.equal(acctNull, 0, 'no restored account left with NULL entity_id');
  const txnNull = await models.Transaction.count({
    where: { householdId: target.id, entityId: null },
  });
  assert.equal(txnNull, 0, 'no restored transaction left with NULL entity_id');
});
