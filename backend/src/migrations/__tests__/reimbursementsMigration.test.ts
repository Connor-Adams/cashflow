/**
 * Round-trip test for migration
 *   20260607000000-create-reimbursements
 *
 * Mirrors transactionReturnMetadataMigration.test.ts: spin up an in-memory
 * SQLite DB, stub the parent tables the FKs reference (households,
 * transactions, contacts, users), then run `up` + assert + `down` + assert.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
let migration: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up: (...args: any[]) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  down: (...args: any[]) => Promise<void>;
};

before(async () => {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  // Enforce FK constraints so SET NULL / CASCADE behaviour is exercised.
  await sequelize.query('PRAGMA foreign_keys = ON;');
  const qi = sequelize.getQueryInterface();
  // Stub parent tables so the FK references resolve.
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('contacts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260607000000-create-reimbursements.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates reimbursements with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('reimbursements'),
    `Expected reimbursements in: ${tables.join(', ')}`,
  );
  const cols = await sequelize
    .getQueryInterface()
    .describeTable('reimbursements');
  for (const col of [
    'id',
    'household_id',
    'transaction_id',
    'contact_id',
    'party_name',
    'amount',
    'currency',
    'due_date',
    'status',
    'repayment_transaction_id',
    'received_at',
    'created_by_user_id',
    'notes',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(col in cols, `Expected column ${col} in reimbursements`);
  }
});

test('default status is "expected"', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO transactions (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO reimbursements
       (household_id, transaction_id, amount, currency, created_at, updated_at)
     VALUES (1, 1, '42.0000', 'CAD', datetime('now'), datetime('now'))`,
  );
  const [rows] = (await sequelize.query(
    `SELECT status FROM reimbursements WHERE household_id = 1`,
  )) as [{ status: string }[], unknown];
  assert.equal(rows[0]?.status, 'expected');
});

test('contact_id SET NULL on contact delete; row survives', async () => {
  await sequelize.query(`INSERT INTO contacts (id) VALUES (10)`);
  await sequelize.query(
    `INSERT INTO reimbursements
       (household_id, transaction_id, contact_id, amount, currency, created_at, updated_at)
     VALUES (1, 1, 10, '5.0000', 'CAD', datetime('now'), datetime('now'))`,
  );
  await sequelize.query(`DELETE FROM contacts WHERE id = 10`);
  const [rows] = (await sequelize.query(
    `SELECT contact_id FROM reimbursements WHERE contact_id IS NULL`,
  )) as [{ contact_id: number | null }[], unknown];
  assert.ok(
    rows.length >= 1,
    'expected at least one reimbursement with contact_id nulled out',
  );
});

test('transaction_id CASCADE deletes the claim with its outlay', async () => {
  await sequelize.query(`INSERT INTO transactions (id) VALUES (2)`);
  await sequelize.query(
    `INSERT INTO reimbursements
       (household_id, transaction_id, amount, currency, created_at, updated_at)
     VALUES (1, 2, '9.0000', 'CAD', datetime('now'), datetime('now'))`,
  );
  await sequelize.query(`DELETE FROM transactions WHERE id = 2`);
  const [rows] = (await sequelize.query(
    `SELECT id FROM reimbursements WHERE transaction_id = 2`,
  )) as [{ id: number }[], unknown];
  assert.equal(rows.length, 0, 'cascade should delete claims for the outlay');
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('reimbursements'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
