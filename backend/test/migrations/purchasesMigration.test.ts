/**
 * Round-trip test for migration 20260603000002-create-purchases. Mirrors the
 * pattern in taxTagsMigration.test.ts: spin up an in-memory SQLite DB, stub
 * the parent tables (households, users, transactions), run up + assert + down.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Stub the parent tables the migration references.
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await sequelize.getQueryInterface().createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await sequelize.getQueryInterface().createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260603000002-create-purchases.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates the purchases table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('purchases'), `Expected purchases in: ${tables.join(', ')}`);
});

test('purchases table has expected columns', async () => {
  const desc = await sequelize.getQueryInterface().describeTable('purchases');
  const cols = Object.keys(desc);
  for (const expected of [
    'transaction_id',
    'household_id',
    'marked_at',
    'marked_by_user_id',
    'receipt_status',
    'warranty_status',
    'warranty_expires_at',
    'warranty_provider',
    'business_relevant',
    'useful_life_months',
    'notes',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(cols.includes(expected), `Missing column ${expected}; got: ${cols.join(', ')}`);
  }
});

test('transaction_id is the primary key (1:1 with transactions)', async () => {
  // Seed parent rows.
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO transactions (id) VALUES (10)`);
  await sequelize.query(
    `INSERT INTO purchases (transaction_id, household_id, marked_at, receipt_status, warranty_status, business_relevant, created_at, updated_at)
     VALUES (10, 1, datetime('now'), 'unknown', 'unknown', 0, datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO purchases (transaction_id, household_id, marked_at, receipt_status, warranty_status, business_relevant, created_at, updated_at)
         VALUES (10, 1, datetime('now'), 'unknown', 'unknown', 0, datetime('now'), datetime('now'))`,
      ),
    /UNIQUE|PRIMARY/i,
    'inserting a second row with the same transaction_id should fail',
  );
});

test('down removes the purchases table', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(!tables.includes('purchases'), `Expected purchases gone; still in: ${tables.join(', ')}`);
});
