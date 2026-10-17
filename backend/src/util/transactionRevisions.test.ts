import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account, Household, Transaction, TransactionRevision } from '../models';
import { withRevisionContext } from './transactionRevisions';

// The Transaction afterUpdate hook writes a TransactionRevision with the
// CALLER's transaction and swallows a failure so the update still lands. On
// Postgres a failed statement aborts the whole transaction: every later
// statement fails with "current transaction is aborted" and COMMIT becomes a
// ROLLBACK, so swallowing the error inside the caller's transaction loses the
// update it claimed to protect. The insert must run in its own SAVEPOINT and
// roll back to it on failure.
//
// SQLite does not abort the transaction on a failed statement, so this test
// cannot reproduce the Postgres loss directly. It asserts the mechanism instead
// (SAVEPOINT + ROLLBACK TO SAVEPOINT around the failed insert) and that the
// outer update still commits.

const REV_TABLE = TransactionRevision.getTableName() as string;
const HIDDEN_TABLE = `${REV_TABLE}_hidden`;
let sql: string[] = [];
const originalLogging = sequelize.options.logging;

before(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(() => {
  sql = [];
  sequelize.options.logging = (msg: unknown) => {
    sql.push(String(msg));
  };
});

afterEach(async () => {
  sequelize.options.logging = originalLogging;
  const tables = (await sequelize.getQueryInterface().showAllTables()) as string[];
  if (tables.includes(HIDDEN_TABLE)) {
    await sequelize.getQueryInterface().renameTable(HIDDEN_TABLE, REV_TABLE);
  }
});

async function seedTxn(): Promise<Transaction> {
  const hh = await Household.create({ name: 'Revisions' } as never);
  const account = await Account.create({
    name: 'Chequing', householdId: hh.id, accountType: 'checking', defaultCurrency: 'CAD',
  } as never);
  return Transaction.create({
    accountId: account.id, householdId: hh.id, date: '2025-06-01', amount: '-10.0000',
    currency: 'CAD', merchantRaw: 'SHOP', merchantClean: 'SHOP', importBatch: 'seed',
    sourceRowFingerprint: `fp-${Date.now()}-${Math.random()}`,
    sourceIdentityFingerprint: `sif-${Date.now()}-${Math.random()}`,
  } as never);
}

test('a failed revision insert rolls back to its own savepoint and the update still commits', async () => {
  const txn = await seedTxn();
  // Make the revision INSERT fail at the database, not in JS validation.
  await sequelize.getQueryInterface().renameTable(REV_TABLE, HIDDEN_TABLE);
  sql = [];

  await withRevisionContext({ source: 'user', changedByUserId: null }, () =>
    sequelize.transaction(async (t) => {
      await txn.update({ notes: 'edited' }, { transaction: t });
      // A later statement in the same transaction must still work.
      await Transaction.findByPk(txn.id, { transaction: t });
    }),
  );

  const failedInsert = sql.findIndex((s) => /INSERT INTO [`"]?transaction_revisions/i.test(s));
  assert.ok(failedInsert >= 0, 'the revision insert was attempted');
  const savepoint = sql.findIndex((s, i) => i < failedInsert && /\bSAVEPOINT\b/.test(s) && !/ROLLBACK/.test(s));
  assert.ok(savepoint >= 0, `a SAVEPOINT precedes the insert:\n${sql.join('\n')}`);
  assert.ok(
    sql.some((s, i) => i > failedInsert && /ROLLBACK TO SAVEPOINT/.test(s)),
    `the failed insert is rolled back to its savepoint:\n${sql.join('\n')}`,
  );

  await txn.reload();
  assert.equal(txn.notes, 'edited');
});

test('with no outer transaction the revision insert runs directly and failures are swallowed', async () => {
  const txn = await seedTxn();
  await sequelize.getQueryInterface().renameTable(REV_TABLE, HIDDEN_TABLE);
  sql = [];

  await txn.update({ notes: 'autocommit edit' });

  assert.ok(!sql.some((s) => /SAVEPOINT/.test(s)), 'no savepoint without an outer transaction');
  await txn.reload();
  assert.equal(txn.notes, 'autocommit edit');
});

test('a successful revision insert inside a transaction is kept', async () => {
  const txn = await seedTxn();
  await sequelize.transaction(async (t) => {
    await txn.update({ notes: 'kept' }, { transaction: t });
  });
  const revs = await TransactionRevision.findAll({ where: { transactionId: txn.id } });
  assert.equal(revs.length, 1);
});
