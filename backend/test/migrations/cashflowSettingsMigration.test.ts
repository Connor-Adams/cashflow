import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260603100001-create-cashflow-settings.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates cashflow_settings table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('cashflow_settings'),
    `Expected cashflow_settings in: ${tables.join(', ')}`,
  );
});

test('cashflow_settings has expected columns with NOT NULL constraints', async () => {
  const description = await sequelize.getQueryInterface().describeTable('cashflow_settings');
  assert.equal(description.user_id?.allowNull, false);
  assert.equal(description.minimum_cash_buffer?.allowNull, false);
  assert.equal(description.safe_to_spend_window_days?.allowNull, false);
  assert.equal(description.include_credit_card_balance?.allowNull, false);
  assert.equal(description.include_goal_contributions?.allowNull, false);
  assert.equal(description.created_at?.allowNull, false);
  assert.equal(description.updated_at?.allowNull, false);
});

test('cashflow_settings defaults a row to safe baseline values', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO cashflow_settings (user_id, created_at, updated_at)
    VALUES (1, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT minimum_cash_buffer, safe_to_spend_window_days,
            include_credit_card_balance, include_goal_contributions
     FROM cashflow_settings WHERE user_id = 1`,
  );
  const row = (rows as Array<{
    minimum_cash_buffer: number | string;
    safe_to_spend_window_days: number;
    include_credit_card_balance: number | boolean;
    include_goal_contributions: number | boolean;
  }>)[0];
  assert.equal(Number(row.minimum_cash_buffer), 0);
  assert.equal(row.safe_to_spend_window_days, 14);
  // SQLite returns boolean as 0/1 — both branches OK.
  assert.ok(row.include_credit_card_balance === 1 || row.include_credit_card_balance === true);
  assert.ok(row.include_goal_contributions === 1 || row.include_goal_contributions === true);
});

test('cashflow_settings enforces UNIQUE(user_id)', async () => {
  await assert.rejects(
    sequelize.query(`
      INSERT INTO cashflow_settings (user_id, created_at, updated_at)
      VALUES (1, datetime('now'), datetime('now'))
    `),
    /UNIQUE constraint failed|unique/i,
  );
});

test('down drops the cashflow_settings table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('cashflow_settings'),
    `cashflow_settings should be gone, found: ${tables.join(', ')}`,
  );
});
