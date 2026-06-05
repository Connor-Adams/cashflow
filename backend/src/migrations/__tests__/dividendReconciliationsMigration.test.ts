import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mig = { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };
let migration: Mig;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Enforce FK constraints in sqlite so the SET NULL / CASCADE assertions hold.
  await sequelize.query('PRAGMA foreign_keys = ON;');
  const qi = sequelize.getQueryInterface();

  // Precursor tables the FKs resolve against. Minimal — only what the
  // migration references.
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('securities', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('security_dividends', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    security_id: { type: DataTypes.INTEGER, allowNull: false },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    account_id: { type: DataTypes.INTEGER, allowNull: false },
  });

  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO accounts (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO securities (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO security_dividends (id, security_id) VALUES (1, 1)`);
  await sequelize.query(`INSERT INTO transactions (id, account_id) VALUES (1, 1)`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260609000001-create-dividend-reconciliations.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates dividend_reconciliations with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('dividend_reconciliations'),
    `Expected dividend_reconciliations in: ${tables.join(', ')}`,
  );
  const cols = await sequelize
    .getQueryInterface()
    .describeTable('dividend_reconciliations');
  assert.equal(cols.security_dividend_id?.allowNull, false);
  assert.equal(cols.account_id?.allowNull, false);
  assert.equal(cols.household_id?.allowNull, true);
  assert.equal(cols.matched_transaction_id?.allowNull, true);
  assert.equal(cols.matched_at?.allowNull, true);
  assert.equal(cols.match_source?.allowNull, false);
  assert.ok(cols.expected_amount, 'expected_amount column should exist');
  assert.ok(cols.shares, 'shares column should exist');
  assert.ok(cols.notified_unmatched_at, 'notified_unmatched_at column should exist');
});

test('unique index (security_dividend_id, account_id) visible by name', async () => {
  const indexes = await sequelize
    .getQueryInterface()
    .showIndex('dividend_reconciliations');
  const found = (indexes as Array<{ name: string; unique?: boolean }>).find(
    (i) => i.name === 'dividend_reconciliations_dividend_account',
  );
  assert.ok(found, 'expected unique index by name');
  assert.equal(found?.unique, true);
});

test('unique (security_dividend_id, account_id) rejects a duplicate', async () => {
  await sequelize.query(
    `INSERT INTO dividend_reconciliations
       (security_dividend_id, account_id, household_id, match_source, created_at, updated_at)
     VALUES (1, 1, 1, 'auto', datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO dividend_reconciliations
           (security_dividend_id, account_id, household_id, match_source, created_at, updated_at)
         VALUES (1, 1, 1, 'auto', datetime('now'), datetime('now'))`,
      ),
    (err: Error) => err instanceof Error,
  );
});

test('deleting matched transaction sets matched_transaction_id NULL (SET NULL)', async () => {
  // Link the seeded reconciliation row to txn 1, then delete the txn.
  await sequelize.query(
    `UPDATE dividend_reconciliations SET matched_transaction_id = 1, matched_at = datetime('now') WHERE security_dividend_id = 1 AND account_id = 1`,
  );
  await sequelize.query(`DELETE FROM transactions WHERE id = 1`);
  const [rows] = await sequelize.query(
    `SELECT matched_transaction_id FROM dividend_reconciliations WHERE security_dividend_id = 1 AND account_id = 1`,
  );
  const row = (rows as Array<{ matched_transaction_id: number | null }>)[0];
  assert.equal(row.matched_transaction_id, null);
});

test('down drops dividend_reconciliations', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('dividend_reconciliations'),
    `dividend_reconciliations should be gone, found: ${tables.join(', ')}`,
  );
});
