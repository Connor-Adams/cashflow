/**
 * Round-trip test for migration
 *   20260608000004-create-debt-payoff-scenarios
 *
 * `debt_payoff_scenarios` persists a saved payoff plan configuration (#202):
 * a named strategy (avalanche | snowball | custom) + extra monthly payment +
 * a JSON payload snapshot (custom ordering, liabilities used). The computed
 * schedule itself is derived on read, not stored.
 *
 * In-memory SQLite, stub parent tables (households, users), run up + assert
 * shape + defaults + FK semantics, then down.
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
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260608000004-create-debt-payoff-scenarios.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates debt_payoff_scenarios with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('debt_payoff_scenarios'),
    `Expected debt_payoff_scenarios in: ${tables.join(', ')}`,
  );
  const cols = await sequelize.getQueryInterface().describeTable('debt_payoff_scenarios');
  for (const col of [
    'id',
    'household_id',
    'user_id',
    'name',
    'strategy',
    'extra_monthly_payment',
    'payload_json',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(col in cols, `Expected column ${col} in debt_payoff_scenarios`);
  }
  assert.equal(cols.household_id.allowNull, false);
  assert.equal(cols.name.allowNull, false);
  assert.equal(cols.strategy.allowNull, false);
});

test('extra_monthly_payment defaults to 0', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO debt_payoff_scenarios
       (household_id, name, strategy, created_at, updated_at)
     VALUES (1, 'My plan', 'avalanche', datetime('now'), datetime('now'))`,
  );
  const [rows] = (await sequelize.query(
    `SELECT extra_monthly_payment FROM debt_payoff_scenarios WHERE household_id = 1`,
  )) as [{ extra_monthly_payment: string }[], unknown];
  assert.equal(Number(rows[0]?.extra_monthly_payment), 0);
});

test('household_id CASCADE deletes scenarios with the household', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (2)`);
  await sequelize.query(
    `INSERT INTO debt_payoff_scenarios
       (household_id, name, strategy, created_at, updated_at)
     VALUES (2, 'Plan B', 'snowball', datetime('now'), datetime('now'))`,
  );
  await sequelize.query(`DELETE FROM households WHERE id = 2`);
  const [rows] = (await sequelize.query(
    `SELECT id FROM debt_payoff_scenarios WHERE household_id = 2`,
  )) as [{ id: number }[], unknown];
  assert.equal(rows.length, 0, 'cascade should delete scenarios when the household is deleted');
});

test('user_id SET NULL on user delete; scenario survives', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (50)`);
  await sequelize.query(
    `INSERT INTO debt_payoff_scenarios
       (household_id, user_id, name, strategy, created_at, updated_at)
     VALUES (1, 50, 'Owned plan', 'custom', datetime('now'), datetime('now'))`,
  );
  await sequelize.query(`DELETE FROM users WHERE id = 50`);
  const [rows] = (await sequelize.query(
    `SELECT user_id FROM debt_payoff_scenarios WHERE name = 'Owned plan'`,
  )) as [{ user_id: number | null }[], unknown];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.user_id, null);
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('debt_payoff_scenarios'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
