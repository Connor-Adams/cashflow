import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mig = { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };
let migration: Mig;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Minimal liability_accounts shape — only the fields the column add touches.
  await sequelize.getQueryInterface().createTable('liability_accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    account_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    interest_rate: { type: DataTypes.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
    minimum_payment: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
    statement_balance: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    due_day: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  // Seed a legacy row to prove backfill leaves it untouched (null).
  await sequelize.query(
    `INSERT INTO liability_accounts (id, account_id, household_id, interest_rate, minimum_payment, created_at, updated_at)
     VALUES (1, 100, 1, 19.99, 50, datetime('now'), datetime('now'))`
  );

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260610000000-liability-accounts-credit-limit.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds credit_limit column nullable; existing rows backfill to null', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('liability_accounts');
  assert.ok(cols.credit_limit, 'credit_limit column should exist');
  const [rows] = await sequelize.query(`SELECT credit_limit FROM liability_accounts WHERE id = 1`);
  const row = (rows as Array<{ credit_limit: string | null }>)[0];
  assert.equal(row.credit_limit, null);
});

test('credit_limit accepts DECIMAL values', async () => {
  await sequelize.query(
    `INSERT INTO liability_accounts (id, account_id, household_id, interest_rate, minimum_payment, credit_limit, created_at, updated_at)
     VALUES (2, 101, 1, 19.99, 50, 5000.0000, datetime('now'), datetime('now'))`
  );
  const [rows] = await sequelize.query(`SELECT credit_limit FROM liability_accounts WHERE id = 2`);
  const row = (rows as Array<{ credit_limit: string | number | null }>)[0];
  assert.equal(Number(row.credit_limit), 5000);
});

test('down removes credit_limit cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('liability_accounts');
  assert.equal(cols.credit_limit, undefined);
});
