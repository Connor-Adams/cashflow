/**
 * Round-trip test for migration
 *   20260603000003-transaction-return-metadata
 *
 * Mirrors the pattern in taxTagsMigration.test.ts: spin up an in-memory
 * SQLite DB, stub the parent `transactions` table, then run `up` + assert +
 * `down` + assert.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Stub parent table so the FK reference resolves.
  await sequelize.getQueryInterface().createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260603000003-transaction-return-metadata.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates transaction_return_metadata with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('transaction_return_metadata'),
    `Expected transaction_return_metadata in: ${tables.join(', ')}`,
  );
  const cols = await sequelize.getQueryInterface().describeTable(
    'transaction_return_metadata',
  );
  assert.ok('transaction_id' in cols);
  assert.ok('return_deadline' in cols);
  assert.ok('warranty_end_date' in cols);
  assert.ok('notes' in cols);
  assert.ok('receipt_status' in cols);
  assert.ok('created_at' in cols);
  assert.ok('updated_at' in cols);
});

test('1:1 mapping enforced by transaction_id PK', async () => {
  await sequelize.query(`INSERT INTO transactions (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO transaction_return_metadata
       (transaction_id, return_deadline, warranty_end_date, notes, receipt_status, created_at, updated_at)
     VALUES (1, '2026-06-30', '2027-05-26', 'AppleCare+', 'have', datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO transaction_return_metadata
           (transaction_id, return_deadline, warranty_end_date, notes, receipt_status, created_at, updated_at)
         VALUES (1, '2027-06-30', NULL, 'dup', 'unknown', datetime('now'), datetime('now'))`,
      ),
    (err: Error) => err instanceof Error,
  );
});

test('default receipt_status is "unknown"', async () => {
  await sequelize.query(`INSERT INTO transactions (id) VALUES (2)`);
  await sequelize.query(
    `INSERT INTO transaction_return_metadata
       (transaction_id, created_at, updated_at)
     VALUES (2, datetime('now'), datetime('now'))`,
  );
  const [rows] = (await sequelize.query(
    `SELECT receipt_status FROM transaction_return_metadata WHERE transaction_id = 2`,
  )) as [{ receipt_status: string }[], unknown];
  assert.equal(rows[0]?.receipt_status, 'unknown');
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('transaction_return_metadata'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
