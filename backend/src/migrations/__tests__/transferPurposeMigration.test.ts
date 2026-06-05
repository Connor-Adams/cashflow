/**
 * Round-trip test for migration 20260603000001-transaction-transfer-purpose.
 *
 * Mirrors the pattern in taxTagsMigration.test.ts: spin up an in-memory
 * SQLite DB, stub the parent `transactions` table with the columns the
 * migration touches, run `up` + assert + `down` + assert.
 *
 * Coverage:
 *   - `up` adds `transfer_purpose` (nullable STRING(32)) and
 *     `transfer_linked_at` (nullable TIMESTAMP).
 *   - `up` adds the composite index `txn_type_linked_transaction_id`.
 *   - `down` removes both columns and the index cleanly.
 *   - Existing rows survive the round-trip without data loss.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Minimal stub of the columns the migration references on `transactions`.
  await sequelize.getQueryInterface().createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    txn_type: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'purchase' },
    linked_transaction_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  // Seed a row so we can prove the column-add preserves existing data.
  await sequelize.query(
    `INSERT INTO transactions (id, txn_type, linked_transaction_id) VALUES (1, 'transfer', NULL)`,
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260603000001-transaction-transfer-purpose.js');
});

after(async () => {
  await sequelize.close();
});

test('up: adds transfer_purpose and transfer_linked_at columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok('transfer_purpose' in desc, 'transfer_purpose column missing');
  assert.ok('transfer_linked_at' in desc, 'transfer_linked_at column missing');
  assert.equal(desc.transfer_purpose.allowNull, true, 'transfer_purpose must be nullable');
  assert.equal(desc.transfer_linked_at.allowNull, true, 'transfer_linked_at must be nullable');
});

test('up: adds composite index on (txn_type, linked_transaction_id)', async () => {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('transactions')) as Array<{ name: string }>;
  assert.ok(
    indexes.some((i) => i.name === 'transactions_txn_type_linked_transaction_id'),
    `expected index transactions_txn_type_linked_transaction_id, got ${indexes.map((i) => i.name).join(', ')}`,
  );
});

test('up preserves existing rows', async () => {
  const [rows] = (await sequelize.query(`SELECT id, txn_type FROM transactions`)) as [
    Array<{ id: number; txn_type: string }>,
    unknown,
  ];
  assert.equal(rows.length, 1, 'pre-existing row must survive the up migration');
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].txn_type, 'transfer');
});

test('transfer_purpose accepts owner_draw / null / clears', async () => {
  // Set then null on the existing row to prove the column round-trips.
  await sequelize.query(
    `UPDATE transactions SET transfer_purpose = 'owner_draw' WHERE id = 1`,
  );
  const [setRows] = (await sequelize.query(
    `SELECT transfer_purpose FROM transactions WHERE id = 1`,
  )) as [Array<{ transfer_purpose: string | null }>, unknown];
  assert.equal(setRows[0].transfer_purpose, 'owner_draw');

  await sequelize.query(`UPDATE transactions SET transfer_purpose = NULL WHERE id = 1`);
  const [nulledRows] = (await sequelize.query(
    `SELECT transfer_purpose FROM transactions WHERE id = 1`,
  )) as [Array<{ transfer_purpose: string | null }>, unknown];
  assert.equal(nulledRows[0].transfer_purpose, null);
});

test('down: removes the index and both columns cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok(!('transfer_purpose' in desc), 'transfer_purpose should be removed');
  assert.ok(!('transfer_linked_at' in desc), 'transfer_linked_at should be removed');
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('transactions')) as Array<{ name: string }>;
  assert.ok(
    !indexes.some((i) => i.name === 'transactions_txn_type_linked_transaction_id'),
    'index should be removed by down',
  );
});

test('down: data in untouched columns survives', async () => {
  const [rows] = (await sequelize.query(`SELECT id, txn_type FROM transactions`)) as [
    Array<{ id: number; txn_type: string }>,
    unknown,
  ];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].txn_type, 'transfer');
});
