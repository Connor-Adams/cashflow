/**
 * Round-trip test for migration
 *   20260608000003-create-liability-accounts
 *
 * `liability_accounts` is a 1:1 sidecar for an Account whose accountType is a
 * liability (credit_card | loan | mortgage). It holds the debt-specific fields
 * the debt payoff planner (#202) needs: interest rate, minimum payment,
 * optional statement balance + due day.
 *
 * Mirrors reimbursementsMigration.test.ts: in-memory SQLite, stub the parent
 * tables the FKs reference, run up + assert shape + FK semantics, then down.
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
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.query('PRAGMA foreign_keys = ON;');
  const qi = sequelize.getQueryInterface();
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260608000003-create-liability-accounts.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates liability_accounts with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('liability_accounts'),
    `Expected liability_accounts in: ${tables.join(', ')}`,
  );
  const cols = await sequelize.getQueryInterface().describeTable('liability_accounts');
  for (const col of [
    'id',
    'account_id',
    'household_id',
    'interest_rate',
    'minimum_payment',
    'statement_balance',
    'due_day',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(col in cols, `Expected column ${col} in liability_accounts`);
  }
  assert.equal(cols.account_id.allowNull, false);
  assert.equal(cols.household_id.allowNull, false);
  assert.equal(cols.interest_rate.allowNull, false);
  assert.equal(cols.minimum_payment.allowNull, false);
  assert.equal(cols.statement_balance.allowNull, true);
  assert.equal(cols.due_day.allowNull, true);
});

test('account_id is unique (1:1 with an account)', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO accounts (id) VALUES (100)`);
  await sequelize.query(
    `INSERT INTO liability_accounts
       (account_id, household_id, interest_rate, minimum_payment, created_at, updated_at)
     VALUES (100, 1, '19.9900', '50.0000', datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    sequelize.query(
      `INSERT INTO liability_accounts
         (account_id, household_id, interest_rate, minimum_payment, created_at, updated_at)
       VALUES (100, 1, '5.0000', '10.0000', datetime('now'), datetime('now'))`,
    ),
    /unique/i,
  );
});

test('account_id CASCADE deletes the sidecar with its account', async () => {
  await sequelize.query(`INSERT INTO accounts (id) VALUES (200)`);
  await sequelize.query(
    `INSERT INTO liability_accounts
       (account_id, household_id, interest_rate, minimum_payment, created_at, updated_at)
     VALUES (200, 1, '12.0000', '25.0000', datetime('now'), datetime('now'))`,
  );
  await sequelize.query(`DELETE FROM accounts WHERE id = 200`);
  const [rows] = (await sequelize.query(
    `SELECT id FROM liability_accounts WHERE account_id = 200`,
  )) as [{ id: number }[], unknown];
  assert.equal(rows.length, 0, 'cascade should delete the sidecar when its account is deleted');
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('liability_accounts'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
