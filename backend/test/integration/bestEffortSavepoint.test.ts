/**
 * Postgres-only semantics of best-effort writes inside a caller's transaction.
 *
 * On Postgres a failed statement aborts the whole transaction: later statements
 * fail with "current transaction is aborted" and COMMIT is answered with
 * ROLLBACK. Catching the error is not enough; the write must run in its own
 * savepoint and roll back to it (src/util/inSavepoint.ts). SQLite keeps the
 * transaction alive after a failed statement, so the unit tests can only assert
 * the SQL issued; this file proves the behaviour on the real dialect.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let models: typeof import('../../src/models/index.js');
let db: typeof import('../../src/db.js');
let inSavepoint: typeof import('../../src/util/inSavepoint.js').inSavepoint;

before(async () => {
  testDb = await setupPgTestDb('best-effort-savepoint');
  models = await import('../../src/models/index.js');
  db = await import('../../src/db.js');
  ({ inSavepoint } = await import('../../src/util/inSavepoint.js'));
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('control: a swallowed failure without a savepoint poisons the transaction', async () => {
  await assert.rejects(
    db.sequelize.transaction(async (t) => {
      try {
        await db.sequelize.query('SELECT * FROM no_such_table', { transaction: t });
      } catch {
        /* swallowed, as the old best-effort code did */
      }
      await models.Household.create({ name: 'poisoned' } as never, { transaction: t });
    }),
    /current transaction is aborted/,
  );
  assert.equal(await models.Household.count({ where: { name: 'poisoned' } }), 0);
});

test('a failure inside inSavepoint leaves the caller transaction usable', async () => {
  await db.sequelize.transaction(async (t) => {
    await models.Household.create({ name: 'sp-before' } as never, { transaction: t });
    try {
      await inSavepoint(t, (sp) => db.sequelize.query('SELECT * FROM no_such_table', { transaction: sp }));
    } catch {
      /* best-effort */
    }
    await models.Household.create({ name: 'sp-after' } as never, { transaction: t });
  });
  assert.equal(await models.Household.count({ where: { name: ['sp-before', 'sp-after'] } }), 2);
});

test('a Transaction update commits even when its revision insert fails', async () => {
  const hh = await models.Household.create({ name: 'revisions-pg' } as never);
  const account = await models.Account.create({
    name: 'Chequing', householdId: hh.id, accountType: 'checking', defaultCurrency: 'CAD',
  } as never);
  const txn = await models.Transaction.create({
    accountId: account.id, householdId: hh.id, date: '2025-06-01', amount: '-10.0000',
    currency: 'CAD', merchantRaw: 'SHOP', merchantClean: 'SHOP', importBatch: 'seed',
    sourceRowFingerprint: 'fp-rev-pg-1', sourceIdentityFingerprint: 'sif-rev-pg-1',
  } as never);

  const qi = db.sequelize.getQueryInterface();
  await qi.renameTable('transaction_revisions', 'transaction_revisions_hidden');
  try {
    await db.sequelize.transaction(async (t) => {
      await txn.update({ notes: 'edited on pg' }, { transaction: t });
      await models.Transaction.findByPk(txn.id, { transaction: t });
    });
  } finally {
    await qi.renameTable('transaction_revisions_hidden', 'transaction_revisions');
  }

  await txn.reload();
  assert.equal(txn.notes, 'edited on pg');
});
